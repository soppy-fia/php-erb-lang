# PHP + ERB Language

`php-erb-lang` provides syntax highlighting and IntelliSense for hybrid ERB + PHP templates (`.php.erb`, `.erb.php`, `.rphp`)

- Syntax highlighting for HTML/CSS/JS code with embedded Ruby and PHP that use the standard `<% %>` `<?php ?>` tags.
- Autocompletion, typehinting, signatures, definitions and diagnostics are provided by Ruby LSP and Intelephense as well as the built-in HTML language features.
- A cache is built in the working directory (`.php-erb-cache`) to keep track of the languages. It is automatically ignored from VSCode and a .gitignore file gets written to it which keeps the cache untracked. The cached files are removed when no longer necessary.

This extension is probably *very* niche and was made for a specific scenario where I want to output a combination of dynamic and static code in my favourite languages. It's the best of both worlds!

Disclaimer: Generative AI was used to assist with programming.