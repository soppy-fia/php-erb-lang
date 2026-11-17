import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const LANG_ID = 'php-erb';
const CACHE_FOLDER_NAME = '.php-erb-cache';

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

interface ShadowEntry {
  originalUri: vscode.Uri;
  phpUri: vscode.Uri;
  rbUri: vscode.Uri;
  htmlUri: vscode.Uri;
}

const shadowMap = new Map<string, ShadowEntry>();

function maskTags(content: string, regex: RegExp): string {
  return content.replace(regex, (match) => {
    return match.replace(/[^\r\n]/g, ' ');
  });
}

function maskNonRuby(content: string): string {
  let result = '';
  let lastIndex = 0;
  const erbRegex = /<%([#=-]?)([\s\S]*?)-?%>/g;
  let match: RegExpExecArray | null;

  while ((match = erbRegex.exec(content)) !== null) {
    const outside = content.slice(lastIndex, match.index);
    result += outside.replace(/[^\r\n]/g, ' ');

    const [fullMatch, modifier = '', code = ''] = match;
    const openLen = 2 + modifier.length;
    const closeLen = fullMatch.endsWith('-%>') ? 3 : 2;

    if (modifier === '#') {
      result += fullMatch.replace(/[^\r\n]/g, ' ');
    } else {
      result += ' '.repeat(openLen) + code + ' '.repeat(closeLen);
    }

    lastIndex = erbRegex.lastIndex;
  }

  result += content.slice(lastIndex).replace(/[^\r\n]/g, ' ');
  return result;
}

function getLanguageAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): 'ruby' | 'php' | 'html' {
  const offset = document.offsetAt(position);
  const textBefore = document.getText().slice(0, offset);

  const lastRubyOpen = textBefore.lastIndexOf('<%');
  const lastRubyClose = textBefore.lastIndexOf('%>');
  if (lastRubyOpen > lastRubyClose) {
    return 'ruby';
  }

  const lastPhpOpen = textBefore.lastIndexOf('<?');
  const lastPhpClose = textBefore.lastIndexOf('?>');
  if (lastPhpOpen > lastPhpClose) {
    return 'php';
  }

  return 'html';
}

function getCacheDirForUri(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const rootDir = workspaceFolder
    ? workspaceFolder.uri.fsPath
    : path.dirname(uri.fsPath);
  return path.join(rootDir, CACHE_FOLDER_NAME);
}

function getShadowBaseName(uri: vscode.Uri): string {
  const hash = crypto.createHash('md5').update(uri.fsPath).digest('hex').slice(0, 8);
  return `${path.basename(uri.fsPath)}.${hash}`;
}

function removeShadowFilesForUri(uri: vscode.Uri) {
  const cacheDir = getCacheDirForUri(uri);
  const baseName = getShadowBaseName(uri);
  for (const ext of ['.php', '.rb', '.html']) {
    const filePath = path.join(cacheDir, `${baseName}${ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  shadowMap.delete(uri.toString());
}

async function cleanupOrphanedCacheFiles() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return;
  }

  const files = await vscode.workspace.findFiles('**/*.{php.erb,erb.php,rphp}');
  const validBaseNames = new Set(files.map((f) => getShadowBaseName(f)));

  for (const folder of folders) {
    const cacheDir = path.join(folder.uri.fsPath, CACHE_FOLDER_NAME);
    if (!fs.existsSync(cacheDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(cacheDir)) {
      if (entry === '.gitignore') {
        continue;
      }
      const withoutExt = entry.replace(/\.(php|rb|html)$/, '');
      if (!validBaseNames.has(withoutExt)) {
        fs.unlinkSync(path.join(cacheDir, entry));
      }
    }
  }
}

function syncShadowFiles(
  document: vscode.TextDocument
): { phpUri: vscode.Uri; rbUri: vscode.Uri; htmlUri: vscode.Uri; } {
  const cacheDir = getCacheDirForUri(document.uri);

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const gitignorePath = path.join(cacheDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf8');
  }

  const baseName = getShadowBaseName(document.uri);

  const phpPath = path.join(cacheDir, `${baseName}.php`);
  const rbPath = path.join(cacheDir, `${baseName}.rb`);
  const htmlPath = path.join(cacheDir, `${baseName}.html`);

  const text = document.getText();
  const phpContent = maskTags(text, /<%[\s\S]*?%>/g);
  const rbContent = maskNonRuby(text);
  const htmlContent = maskTags(phpContent, /<\?(?:php|=)?[\s\S]*?\?>/g);

  fs.writeFileSync(phpPath, phpContent, 'utf8');
  fs.writeFileSync(rbPath, rbContent, 'utf8');
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');

  const phpUri = vscode.Uri.file(phpPath);
  const rbUri = vscode.Uri.file(rbPath);
  const htmlUri = vscode.Uri.file(htmlPath);

  shadowMap.set(document.uri.toString(), {
    originalUri: document.uri,
    phpUri,
    rbUri,
    htmlUri,
  });

  return { phpUri, rbUri, htmlUri };
}

async function openShadowDocuments(uris: {
  phpUri: vscode.Uri;
  rbUri: vscode.Uri;
  htmlUri: vscode.Uri;
}) {
  await vscode.workspace.openTextDocument(uris.phpUri);
  await vscode.workspace.openTextDocument(uris.rbUri);
  await vscode.workspace.openTextDocument(uris.htmlUri);
}

export function activate(context: vscode.ExtensionContext) {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(LANG_ID);
  context.subscriptions.push(diagnosticCollection);

  cleanupOrphanedCacheFiles();

  function forwardDiagnosticsFor(entry: ShadowEntry) {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === entry.originalUri.toString()
    );
    if (!doc) {
      return;
    }

    const phpDiags = vscode.languages.getDiagnostics(entry.phpUri).filter((diag) => {
      return getLanguageAtPosition(doc, diag.range.start) === 'php';
    });

    const rbDiags = vscode.languages.getDiagnostics(entry.rbUri).filter((diag) => {
      return getLanguageAtPosition(doc, diag.range.start) === 'ruby';
    });

    const htmlDiags = vscode.languages.getDiagnostics(entry.htmlUri).filter((diag) => {
      return getLanguageAtPosition(doc, diag.range.start) === 'html';
    });

    diagnosticCollection.set(entry.originalUri, [...phpDiags, ...rbDiags, ...htmlDiags]);
  }

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      const changedStrings = new Set(e.uris.map((u) => u.toString()));

      for (const entry of shadowMap.values()) {
        if (
          changedStrings.has(entry.phpUri.toString()) ||
          changedStrings.has(entry.rbUri.toString()) ||
          changedStrings.has(entry.htmlUri.toString())
        ) {
          forwardDiagnosticsFor(entry);
        }
      }
    })
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === LANG_ID) {
      const uris = syncShadowFiles(doc);
      openShadowDocuments(uris);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === LANG_ID) {
        const uris = syncShadowFiles(doc);
        openShadowDocuments(uris);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== LANG_ID) {
        return;
      }

      if (e.contentChanges.length === 0) {
        return;
      }
      const change = e.contentChanges.at(0);
      if (!change || change.text !== '>') {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== e.document) {
        return;
      }

      const posAfterBracket = change.range.start.translate(0, 1);
      if (getLanguageAtPosition(e.document, posAfterBracket) !== 'html') {
        return;
      }

      const linePrefix = e.document
        .lineAt(change.range.start.line)
        .text.slice(0, posAfterBracket.character);

      const tagMatch = linePrefix.match(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*[^/])?>$/);
      const rawTag = tagMatch?.at(1);
      if (!rawTag) {
        return;
      }

      const tagName = rawTag.toLowerCase();
      if (VOID_HTML_TAGS.has(tagName)) {
        return;
      }

      editor.insertSnippet(new vscode.SnippetString(`$0</${rawTag}>`), posAfterBracket);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === LANG_ID) {
        diagnosticCollection.delete(doc.uri);
        shadowMap.delete(doc.uri.toString());
      }
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) {
        diagnosticCollection.delete(uri);
        removeShadowFilesForUri(uri);
      }
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri } of e.files) {
        diagnosticCollection.delete(oldUri);
        removeShadowFilesForUri(oldUri);
      }
    })
  );

  async function prepareTargetUri(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Uri> {
    const lang = getLanguageAtPosition(document, position);
    const uris = syncShadowFiles(document);
    await openShadowDocuments(uris);
    if (lang === 'ruby') { return uris.rbUri; }
    if (lang === 'php') { return uris.phpUri; }
    return uris.htmlUri;
  }

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: LANG_ID },
    {
      async provideCompletionItems(document, position, _token, context) {
        const targetUri = await prepareTargetUri(document, position);

        return await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          targetUri,
          position,
          context.triggerCharacter
        );
      },
    },
    '.', ':', '>', '$', '@', '<', '"', "'", '=', '/'
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: LANG_ID },
    {
      async provideHover(document, position) {
        const targetUri = await prepareTargetUri(document, position);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          targetUri,
          position
        );

        return hovers && hovers.length > 0 ? hovers[0] : undefined;
      },
    }
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    { language: LANG_ID },
    {
      async provideDefinition(document, position) {
        const targetUri = await prepareTargetUri(document, position);

        return await vscode.commands.executeCommand<vscode.Location | vscode.LocationLink[]>(
          'vscode.executeDefinitionProvider',
          targetUri,
          position
        );
      },
    }
  );

  const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
    { language: LANG_ID },
    {
      async provideSignatureHelp(document, position, _token, context) {
        const targetUri = await prepareTargetUri(document, position);

        return await vscode.commands.executeCommand<vscode.SignatureHelp>(
          'vscode.executeSignatureHelpProvider',
          targetUri,
          position,
          context.triggerCharacter
        );
      },
    },
    '(', ','
  );

  let pendingFormatContent = '';
  const formatScheme = 'php-erb-fmt';

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(formatScheme, {
      provideTextDocumentContent(): string {
        return pendingFormatContent;
      },
    })
  );

  const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
    { language: LANG_ID },
    {
      async provideDocumentFormattingEdits(document) {
        const text = document.getText();
        const blocks: string[] = [];
        const tokenized = text.replace(/(<%[\s\S]*?%>|<\?(?:php|=)?[\s\S]*?\?>)/g, (match) => {
          const idx = blocks.length;
          blocks.push(match);
          return `<!--PHP_ERB_BLOCK_${idx}-->`;
        });

        pendingFormatContent = tokenized;
        const formatUri = vscode.Uri.parse(`${formatScheme}:/format-${Date.now()}.html`);
        const virtualHtmlDoc = await vscode.workspace.openTextDocument(formatUri);

        const formatOptions: vscode.FormattingOptions = {
          tabSize: 4,
          insertSpaces: true,
        };

        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
          'vscode.executeFormatDocumentProvider',
          formatUri,
          formatOptions
        );

        if (!edits || edits.length === 0) {
          return [];
        }

        const sortedEdits = [...edits].sort(
          (a, b) => virtualHtmlDoc.offsetAt(b.range.start) - virtualHtmlDoc.offsetAt(a.range.start)
        );

        let formatted = tokenized;
        for (const e of sortedEdits) {
          const start = virtualHtmlDoc.offsetAt(e.range.start);
          const end = virtualHtmlDoc.offsetAt(e.range.end);
          formatted = formatted.slice(0, start) + e.newText + formatted.slice(end);
        }

        formatted = formatted.replace(/<!--PHP_ERB_BLOCK_(\d+)-->/g, (_m, idxStr) => {
          return blocks.at(Number(idxStr)) ?? '';
        });

        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(text.length)
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
      },
    }
  );

  const toggleCommentCommand = vscode.commands.registerTextEditorCommand(
    'php-erb.toggleLineComment',
    (editor, edit) => {
      const doc = editor.document;
      const lineNumbers = new Set<number>();

      for (const sel of editor.selections) {
        const endLine =
          sel.end.line > sel.start.line && sel.end.character === 0
            ? sel.end.line - 1
            : sel.end.line;
        for (let line = sel.start.line; line <= endLine; line++) {
          lineNumbers.add(line);
        }
      }

      for (const lineNum of lineNumbers) {
        const line = doc.lineAt(lineNum);
        const trimmed = line.text.trim();
        if (!trimmed) {
          continue;
        }

        const firstNonWs = line.firstNonWhitespaceCharacterIndex;
        const indent = line.text.slice(0, firstNonWs);
        const pos = new vscode.Position(lineNum, firstNonWs);
        const lang = getLanguageAtPosition(doc, pos);

        if (lang === 'ruby') {
          if (trimmed.startsWith('#')) {
            const uncommented = trimmed.replace(/^#\s?/, '');
            edit.replace(line.range, indent + uncommented);
          } else {
            edit.replace(line.range, `${indent}# ${trimmed}`);
          }
        } else if (lang === 'php') {
          if (trimmed.startsWith('//')) {
            const uncommented = trimmed.replace(/^\/\/\s?/, '');
            edit.replace(line.range, indent + uncommented);
          } else {
            edit.replace(line.range, `${indent}// ${trimmed}`);
          }
        } else {
          if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
            const uncommented = trimmed.replace(/^<!--\s?/, '').replace(/\s?-->$/, '');
            edit.replace(line.range, indent + uncommented);
          } else {
            edit.replace(line.range, `${indent}<!-- ${trimmed} -->`);
          }
        }
      }
    }
  );

  const colorProvider = vscode.languages.registerColorProvider(
    { language: LANG_ID },
    {
      async provideDocumentColors(document) {
        const { htmlUri } = syncShadowFiles(document);
        await vscode.workspace.openTextDocument(htmlUri);

        const colors = await vscode.commands.executeCommand<vscode.ColorInformation[]>(
          'vscode.executeDocumentColorProvider',
          htmlUri
        );

        return colors ?? [];
      },
      async provideColorPresentations(color, context) {
        const { htmlUri } = syncShadowFiles(context.document);
        await vscode.workspace.openTextDocument(htmlUri);

        const presentations = await vscode.commands.executeCommand<vscode.ColorPresentation[]>(
          'vscode.executeColorPresentationProvider',
          color,
          { uri: htmlUri, range: context.range }
        );

        return presentations ?? [];
      },
    }
  );

  context.subscriptions.push(
    completionProvider,
    hoverProvider,
    definitionProvider,
    signatureHelpProvider,
    formattingProvider,
    toggleCommentCommand,
    colorProvider
  );
}

export function deactivate() {}
