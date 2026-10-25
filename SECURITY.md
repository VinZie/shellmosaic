# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Don't open a public issue for security problems.

Include what an attacker controls (a file, a repository, a web page, terminal output, a plugin,
an SSH server…), what they can achieve, and the steps to reproduce. You'll get an answer within
a few days, and a fix or a plan before anything is made public.

## Supported versions

Only the latest release gets security fixes. Shellmosaic updates itself from GitHub releases
after asking you.

## Scope

In scope: anything that lets untrusted input (files, repositories, markdown, web pages in web
panes, terminal output, plugins, SSH servers, settings or theme files from elsewhere) run code,
read or leak data, reach the backend, or bypass a plugin permission or the vault.

Out of scope: attacks that need an already compromised user account, and plugins doing what
the permissions you granted them allow.
