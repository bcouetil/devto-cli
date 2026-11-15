---
name: testing
description: Guide for testing this CLI. Use this when running tests, validating changes, or experimenting with articles.
---

# Testing

Do not use embedded tests.

We can safely experiment on non published articles (the ones with no date in name), or on any article explicitly indicated by the user.

## Articles path

Own git repo. `reveal-js/articles` is only a symlink to it. Use this path.

| OS      | Path                                                          |
| ------- | ------------------------------------------------------------- |
| Windows | `C:\Users\bc30a3al\workspaces\reveal-js\articles`             |
| macOS   | `/Users/bcouetil/workspaces/zenika/my-articles`               |

## Build
```bash
npx tsc
```

`dev` on `PATH` is this repo via `npm link`. After `tsc`, `dev` runs `lib/` from here. `/opt/homebrew/bin/dev` is that link, not another install. Check with `realpath "$(which dev)"` (must end at this repo's `bin/devto.js`). If the link is missing, say so. Do not work around it with `node bin/devto.js` or a reinstall.

## Test push
```bash
cd <Articles path>  # .env is there, necessary and picked-up automatically
dev push --update-toc "<article-file>.md"
```
