# Development Guide

## Before committing

1. **Update README.md** if you add/change commands or features
2. **Test your changes** following [TESTING.md](TESTING.md)

## Workflow

1. Make your changes in `src/`
2. Compile: `npx tsc`
3. Test using the `dev` CLI (see [TESTING.md](TESTING.md))
4. Update documentation if needed

## CLI Output Guidelines

Use `chalk` for colored output. Follow these conventions:

### Colors

| Color          | Usage                                |
| -------------- | ------------------------------------ |
| `chalk.green`  | Success, updated, created (`✓`)      |
| `chalk.gray`   | Unchanged, skipped, up-to-date (`·`) |
| `chalk.yellow` | Warnings, missing markers (`⚠`)      |
| `chalk.red`    | Errors, failures (`✗`)               |

### Per-file logging

Log each file with its status:

```typescript
console.log(chalk.green(`✓ ${file}`));           // Updated
console.log(chalk.gray(`· ${file} (up-to-date)`)); // No change
console.log(chalk.yellow(`⚠ ${file} (reason)`));   // Warning
console.log(chalk.red(`✗ ${file}: ${error}`));     // Error
```

### Summary

End with a one-line summary:

```typescript
console.log(`Updated: ${chalk.green(count)} | Up-to-date: ${chalk.gray(count)} | Warnings: ${chalk.yellow(count)}`);
```
