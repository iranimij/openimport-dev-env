# Fixture files

Small hand-written files for OpenImport's admin and Playwright tests. They are served by the fixture's `files`
(HTTP) and `sftp` services. Large generated datasets go to `generated/` (not committed, see `bin/datasets`).

- `stock-de.csv`: a German supplier stock feed (semicolon, decimal comma, German headers).
- `products-small.csv`: three products with an English and a German name column.
