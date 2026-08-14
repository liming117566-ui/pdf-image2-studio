# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue for an undisclosed vulnerability.

Include a clear description, affected version or commit, reproducible steps, impact, and a suggested mitigation when available. Remove API keys, passwords, session tokens, private PDFs, generated images, and production configuration from all reports.

We will acknowledge valid reports, investigate them, and coordinate a fix and disclosure timeline with the reporter.

## Deployment Notes

Each deployment must provide its own API endpoint and credentials through environment variables. Keep `.env` files outside version control, use HTTPS in production, and rotate credentials immediately if they are exposed.
