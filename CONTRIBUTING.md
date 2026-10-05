# Contributing

<!-- rst content start -->

Contributions are welcome and greatly appreciated!
Every little bit helps, and credit will always be given.
Environment Setup

## Development

Follow this basic process:

1. Fork and clone the repository.
2. Create a new branch: `git checkout -b feature-or-bugfix-name`.
3. Edit the code.
4. If you added functionality or features, update the documentation accordingly.

If you are unsure about how to fix or ignore a warning, just let the continuous
integration fail, and we will help you during review.

Don't bother updating the changelog, we will take care of this.

## Pull requests guidelines

Link to any related issue in the Pull Request message.

During the review, we recommend using fixups:

```bash
# SHA is the SHA of the commit you want to fix
git commit --fixup=SHA
```

Once all the changes are approved, you can squash your commits:

```bash
git rebase -i --autosquash main
```

And force-push:

```bash
git push -f
```

If this seems all too complicated, you can push or force-push each new commit,
and we will squash them ourselves if needed, before merging.
