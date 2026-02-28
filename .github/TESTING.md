# Testing on Windows

Do not use embedded tests.

Articles for testing purposes are in C:\Users\bc30a3al\workspaces\reveal-js\articles.

We can safely experiment on non published articles (the ones with no date in name), or on any article explicitly indicated by the user.

## Build
```powershell
cd C:\Users\bc30a3al\workspaces\devto-cli
npx tsc
```

## Test push
```powershell
cd C:\Users\bc30a3al\workspaces\reveal-js\articles # .env is there, necessary and picked-up automatically
dev push --update-toc "23_02_07_GITLAB_runner-topologies.md"
```
