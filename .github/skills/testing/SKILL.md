---
name: testing
description: Guide for testing this CLI. Use this when running tests, validating changes, or experimenting with articles.
---

# Testing

Do not use embedded tests.

We can safely experiment on non published articles (the ones with no date in name), or on any article explicitly indicated by the user.

## Articles path

| OS      | Path                                                          |
| ------- | ------------------------------------------------------------- |
| Windows | `C:\Users\bc30a3al\workspaces\reveal-js\articles`             |
| macOS   | `/Users/bcouetil/workspaces/zenika/reveal-js/articles`        |

## Build
```bash
npx tsc
```

## Test push
```bash
cd <Articles path>  # .env is there, necessary and picked-up automatically
dev push --update-toc "<article-file>.md"
```
