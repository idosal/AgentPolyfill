---
name: release-notes
description: Write release notes for the Acme Shop services in the house format. Use when asked for release notes, a changelog entry or a "what shipped" summary.
license: MIT
metadata:
  owner: acme-platform
  version: "3"
---

# Release notes

Acme release notes follow one fixed format, and every note carries the
release's codename.

1. Read `references/codenames.md` to find the codename for the version being
   released. Never invent one.
2. Pick the template that matches the audience from `templates/`:
   `templates/customer.md` for customers, `templates/internal.md` for staff.
3. Fill the template. Keep each bullet to one line, lead with the user-visible
   change, and end with the sign-off line the template gives.
