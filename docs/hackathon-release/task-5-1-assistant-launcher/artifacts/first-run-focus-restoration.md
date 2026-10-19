# First-run focus restoration failure

The first final-source Playwright run reached the second Escape after closing the Home history menu. The dialog closed, but the Ask launcher remained aria-hidden=true and Playwright reported that the launcher was inactive rather than focused. The page itself had no JavaScript page error.

The Home history DropdownMenuRoot was modal by default inside the modal Ask Dialog. It now uses modal=false, leaving the Ask dialog as the single modal focus boundary. The same synthetic browser journey passed afterward, including both Escape handling and launcher focus restoration.

The original Playwright failure output identified frontend/e2e/home-chat.preview.spec.ts at the focus assertion. Its raw trace/screenshot lived under the default activity-preview output directory; a later Playwright run cleaned that directory before the failure files were copied. This note preserves the observed failure and fix. The final successful desktop/mobile screenshots and browser evidence are stored in the task artifacts directory.
