---
"@open-cr-agent/core": patch
---

### Security

- Prompt neutralization also catches tags spelled with any default-ignorable or format character, more look-alike brackets and letters, and fullwidth, mathematical and other compatibility forms, and a `<` that ends a field, so two fields cannot form a tag where they meet.
