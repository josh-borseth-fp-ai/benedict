---
name: security
description: Security weaknesses the change introduces, such as auth mistakes, injection and secret exposure. Applies to every file.
---

# Security

Report weaknesses this change causes:

- Authentication and authorization mistakes.
- Injection: SQL, shell, path, template, HTML and similar.
- Secret exposure in code, logs, errors or responses.
- Unsafe deserialization and parsing of untrusted input.
- Trust-boundary violations, such as acting on user-controlled data without validation.
- Insecure defaults.

Name who controls the input, what they can reach and the impact. A theoretical risk with no reachable path is not a finding.
