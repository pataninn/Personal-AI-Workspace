# Ready composer and keyboard submission diagnostic

This read-only browser probe reused the existing ProjectChatPreviewFixture with its explicitly synthetic ready policy. It captured the initial 1280×720 viewport before interaction, then filled the message area and used a real Tab key to move focus to Send. A second pass used a synthetic 390×844 viewport, and a fresh page used Ctrl+Enter to submit once. No DOM scrolling was scripted.

At desktop size, the empty-message Send button is disabled and below the initial viewport. The message area is partly visible. After the text area receives a draft, native Tab moves focus to the enabled Send button and the browser scrolls the composer’s own overflow:auto region; the button is fully visible at ratio 1. At 390×844, normal fill and Tab also leave the Send button fully visible and focused. This is viewport emulation, not an OS-keyboard test.

The separate Ctrl+Enter case submits exactly one matching chat-runs request through the synthetic fixture. The draft remains in the composer, the legacy consent dialog is absent, and no run-start, decision, provider-permission, external, or unhandled API request is observed.

curated-geometry.json is the measurement record. desktop-initial-1280x720.png, keyboard-tab-desktop.png, keyboard-tab-mobile-390x844.png, and ctrl-enter-after-submit.png are the reviewed screenshots. The source probe uses the existing preview fixture and is retained in the intended export at artifacts/provider-submit-diagnosis/provider-submit-diagnosis.spec.ts; its local runner configuration was not promoted.