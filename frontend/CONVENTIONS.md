# Frontend conventions (BAMP dashboard)

Stack: React 18 + Vite + TailwindCSS 3 + TypeScript, react-router-dom 6, @tanstack/react-query 5, recharts 2.

## Design
- The visual language comes from `../Template design/*.html` (Material 3 dark tokens). All tokens are in
  `tailwind.config.js` with the **same class names as the templates** (`bg-surface-container-low`, `text-on-surface-variant`,
  `font-label-sm text-label-sm`, `p-space-md`, `gap-gutter`, …) so template markup can be ported almost verbatim.
- Icons: Material Symbols Outlined via `<Icon name="router" />` (`fill` prop for filled).
- Fonts: Inter (body/headlines) and JetBrains Mono (`font-mono`, labels, IDs, numbers).
- Templates contain decorative marketing copy (e.g. "FIDO2 / HSM", "Facial", "Iris", fake counts). **Never copy fake data or
  claims.** The product is fingerprint-only; every number, name and status shown must come from the API.
- UX principle (user flow §30): every important object answers *what is happening, is something wrong, where, what can I do* —
  e.g. an offline device shows location · device, last seen, buffered events, employees affected, and [View device] [View location].

## Code
- `@/lib/api` — `api.get/post/put/patch/upload`, `download(path, query)` for CSV/XLSX/PDF, `ApiError {status, code, message, details}`.
  All requests are same-origin (`/api/...`) and send the CSRF header automatically.
- `@/lib/auth` — `useAuth()` → `{ me, can(perm), logout }`. Hide/disable actions the user lacks permission for (server enforces too).
  Permissions: see `backend/src/auth/rbac.ts`.
- `@/lib/live` — `useLiveEvents(prefix, handler)` for WebSocket frames (`attendance/event`, `delivery/updated`, `device/status`,
  `device/reconcile`, `alert/raised`, `alert/updated`, `sync/started`, `sync/finished`, `firmware/target`, `firmware/deployment`,
  `enrolment/session`, `employee/biometric`, `command/updated`). Common query keys are invalidated automatically (see `INVALIDATE`).
- `@/lib/scope` — `useGlobalLocation()` → `[locationId|null, set]` the top-bar location scope; use as the default location filter.
- `@/lib/format` — `num, pct, dateTime, date, time, relative, duration, bytes, humanize, FINGERS, todayIso, tzOffsetLabel`.
- `@/components/ui` — `Icon, Button, LinkButton, Badge, Dot, Panel, PageHeader, Stat, KV, Avatar, Progress, Table/THead/Th/Td/Tr,
  Pagination, Loading, Empty, ErrorState, PermissionDenied, QueryState, Field, Input, Select, Textarea, Toggle, SearchInput,
  useDebounced, Tabs, Modal, ConfirmDialog, useToast, useErrorToast, CopyButton, ExportMenu, JsonBlock` and tone helpers
  `deliveryTone, severityTone, deviceTone, deviceStatusLabel`.
- Query keys: use the prefixes listed in `INVALIDATE` in `src/lib/live.tsx` (e.g. `['dashboard']`, `['devices', filters]`,
  `['device', id]`, `['alerts', filters]`, `['employees', filters]`, `['employee', id]`, `['integration-status']`, `['sync-runs', …]`,
  `['firmware-deployments']`, `['firmware-deployment', id]`, `['enrolment-sessions', …]`, `['delivery-summary']`) so live frames refresh them.
- Global states (user flow §26) must be used: `Loading` ("Loading attendance data..."), `Empty` ("No attendance records found."),
  `ErrorState` (Something went wrong + Try Again), offline banner is global, `PermissionDenied`, and sync results
  ("Synchronizing...", "Synchronization completed successfully.", "Synchronization completed with N errors. [View Errors]").
- Each page is a default-exported component at the path imported in `src/App.tsx`. Pages render inside `AppShell`
  (sidebar + top bar are already there); start the page with `<PageHeader …/>`.
- There is **no "Create Employee"** anywhere (web software is the source of truth); use "Sync from Web Software" instead.
- Mutations: `useMutation` + toast on success, `useErrorToast()` on failure, then `invalidateQueries`.
- Responsive: grids collapse to one column on small screens.
