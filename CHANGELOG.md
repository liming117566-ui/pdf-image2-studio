# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-08-14

### Added

- Selective PDF page extraction with page ranges and repeated extraction support.
- Prompt-based batch image generation through a user-provided OpenAI-compatible image2 endpoint.
- Portrait, 3:4, landscape, and square output modes.
- Persistent projects and tasks backed by SQLite.
- Queue management, configurable concurrency, retries, downloads, authentication, rate limiting, and retention cleanup.
- Docker deployment files and sanitized environment examples.

### Security

- Production endpoints, API keys, server credentials, databases, uploads, and generated files are excluded from the repository.
- Security reporting guidance is documented in `SECURITY.md`.
