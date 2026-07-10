# Session Collaboration Archive

This directory archives collaboration materials that were explicitly named in user prompts from the reviewed Claude sessions.

Source sessions:

- `8d96f251-8751-49b8-bb40-4812588af5ce` from `/home/yydd/.claude/projects/-home-yydd-LaoJi/8d96f251-8751-49b8-bb40-4812588af5ce.jsonl`
- `f6be2d50-97a2-415e-a72c-0e1651bb49a3` from `/home/yydd/.claude/projects/-home-yydd----light-plan/f6be2d50-97a2-415e-a72c-0e1651bb49a3.jsonl`

All archived items were copied only. Source files were not moved or edited.

## Archived Materials

| Topic | Source prompt | Original path | Archived path | Purpose summary |
| --- | --- | --- | --- | --- |
| Product spec | Session `8d96f251...`, line 8, `2026-07-06T08:29:22.540Z` | `/home/yydd/LaoJi/docs/老记：一句话代办与智能日历功能说明.pdf` | `product-spec/老记：一句话代办与智能日历功能说明.pdf` | Product and feature brief for "老记", covering one-sentence schedule creation, natural-language parsing, ASR flow, follow-up clarification, calendar writing, and current implementation status. |
| Figma Make UI export | Session `8d96f251...`, line 117, `2026-07-06T11:21:31.264Z`; repeated by stop-hook feedback later in the same session | `/home/yydd/LaoJi/Generate React components` | `figma-make/Generate React components` | Figma Make generated React/Vite reference bundle for the original UI design, including `README.md`, `src/app/App.tsx`, style files, UI components, and imported design images. Copied as a full directory. |
| Design reference images | Session `8d96f251...`, lines 1592 and 1796, `2026-07-07T07:15:23.524Z` and `2026-07-07T09:04:31.841Z` | `/home/yydd/LaoJi/design/微信图片_20260706135502_4_437.png` and sibling files | `design-reference/` | Original WeChat design screenshots used as the visual reference for the Figma Make export. These files match the images embedded under `figma-make/Generate React components/src/imports/` by SHA-256. |
| Backend/collaboration overview | Session `f6be2d50...`, line 602, `2026-07-08T00:54:51.866Z`; original queued goal also appears in an attachment at line 495 | `/home/yydd/文档/xwechat_files/wxid_au18x4y91fz322_d9d5/msg/file/2026-07/internal-communication-overview.md` | `backend-collaboration/internal-communication-overview.md` | Internal handoff and alignment document for Smart Meeting AI, 老记, ASR support tools, local services, ports, current capabilities, limitations, and integration direction. |

## Ambiguous Attachment

| Source prompt | Original path | Resolution | Notes |
| --- | --- | --- | --- |
| Session `8d96f251...`, lines 1592 and 1796, `2026-07-07T07:15:23.524Z` and `2026-07-07T09:04:31.841Z` | `/home/yydd/LaoJi/design/粘贴的文件.png` | Archived source-directory equivalents | The exact attachment name did not exist on disk, but `/home/yydd/LaoJi/design/` contained four same-session WeChat design screenshots. They have now been copied to `design-reference/`, and their hashes match the Figma Make import images that were already archived. |

## Filtered Path Mentions

The sessions also contained path-like strings that were not archived because they are not collaboration materials:

- `/goal`: Claude command text, not a file.
- `/home/yydd/LaoJi/mobile/...` and `/home/yydd/LaoJi/mobile/node_modules/...` paths in a Metro/Babel error stack: project/runtime paths, not shared materials.
- `/home/yydd/.claude/projects/-home-yydd-LaoJi/8d96f251-8751-49b8-bb40-4812588af5ce.jsonl`: referenced as a source transcript in session `f6be2d50...`, line 4. It was not copied into this archive because it is one of the reviewed source sessions rather than a collaborator artifact, and raw session logs may contain sensitive conversation data.

## Verification

- `product-spec/老记：一句话代办与智能日历功能说明.pdf` SHA-256 matches the source: `a46a0d878636b6bdc273bcfab6dd30cd09b1b589337fa8d131b7c15bc3356882`.
- `backend-collaboration/internal-communication-overview.md` SHA-256 matches the source: `00220a370f2af9677e1c582aaa4f71fcab5efff0880736bb636fbd8133050376`.
- `figma-make/Generate React components` was copied as a 69-file directory, approximately 4.7 MB.
- `design-reference/微信图片_20260706135502_4_437.png` SHA-256 matches both the source and Figma import image: `89ec598037d5106fc052d0db8afde50498912fde0a9bffbc5907aea87cb3dd6d`.
- `design-reference/微信图片_20260706135506_5_437.jpg` SHA-256 matches both the source and Figma import image: `c7eb4651beaab80ad54926389fb64674906b46cdd14b89e6251be490469568c6`.
- `design-reference/微信图片_20260706135511_6_437.jpg` SHA-256 matches both the source and Figma import image: `ee5323af4fbc823fb02ef7dc5e7068880282a258daf7a7d71c34083c0f8b3342`.
- `design-reference/微信图片_20260706135515_7_437.jpg` SHA-256 matches both the source and Figma import image: `54f97fad8f8795db2ec4676c75abef350140463b92d9e746c7f500e2e423bb0e`.
