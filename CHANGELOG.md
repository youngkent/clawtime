# Changelog

All notable changes to ClawTime are documented here.

## [Unreleased]

## [1.5.0] - 2026-02-18

### Added

- Bruni avatar option with avatar selection during setup
- Avatar state persistence (remembers selected avatar across sessions)
- Debug logging for troubleshooting

### Fixed

- Smoother first-time installation experience
- Smooth history scrolling (scroll-to-bottom behavior)

## [1.4.0] - 2026-02-17

### Fixed

- Message truncation during tool calls — messages no longer cut off mid-response

## [1.3.0] - 2026-02-14

### Added

- Voice mode with browser-native STT (Speech-to-Text)
- Barge-in support with VAD (Voice Activity Detection)
- Speech buffering for better recognition
- OpenClaw v2026.2.13 compatibility
- Setup script for easier deployment

## [1.2.0] - 2026-02-12

### Changed

- License changed to MIT
- Split documentation into INSTALL.md (setup) and SKILL.md (operation)

### Fixed

- Widget markup stripping (widgets now render correctly)
- Setup token permanently consumed after use

## [1.1.0] - 2026-02-11

### Added

- Widget system with token auth for testing
- Task panel documentation

### Changed

- Voice bar redesigned: thin, compact, pinned to top of chat area
- Bot messages now full-width

### Fixed

- Voice bar positioning (below separator)
- avatarPanelEl undefined error
- Reconnect after idle now works correctly

## [1.0.0] - 2026-02-06

### Added

- Initial release
- WebAuthn passkey authentication
- Real-time WebSocket chat
- Avatar expressions (10 states: idle, thinking, talking, listening, happy, celebrating, working, sleeping, error, reflecting)
- Widget support (buttons, confirm, progress, code, form, datepicker, carousel)
- Task panel with TODO.md integration
- Mobile-responsive design
