# User Guide

## Roles
| Role | Sees | Can do |
|---|---|---|
| Administrator | All locations, devices, employees, system configuration, audit log | Everything, incl. users, settings, firmware, integration |
| Manager | Assigned locations: attendance, employees, devices, reports | Export reports, acknowledge alerts, device commands |
| Branch Supervisor | Assigned branch: attendance, employees, branch devices | Sync roster / refresh device status; authorise enrolment on the terminal |

## Signing in
Email + password, then the 6-digit code from your authenticator app (MFA is mandatory for administrators and managers by
default). Lost your phone? Use one of your recovery codes, then regenerate codes in *User Profile*. Repeated failures lock the
account temporarily.

## Daily use
- **Dashboard** — today's Present / Absent / Late / Clocked in / Clocked out, live activity, device health, sync status,
  open alerts and a per-location overview. Problems are shown with where they are and what to do.
- **Live Attendance** — real-time feed; filter by location, device, employee, direction, date, status.
- **Attendance History** — search and export (CSV, Excel, PDF); open an event to see its web-software delivery and retries.
- **Reports & Analytics** — choose location, date range, employee or department → daily/weekly/monthly attendance, late
  arrivals, absences, trends; export any view.

## Employees
Employees come from the company web software — there is no "create employee" here. If someone is missing, create or fix
them in the web software and press **Sync from Web Software**. The profile shows identity, assignment, biometric status
(fingers enrolled), attendance and on-device sync status.

## Enrolling fingerprints (at the terminal)
1. Supervisor presses **E** on the terminal and authorises with their fingerprint or PIN.
2. Select the employee (only employees on that branch roster appear).
3. Capture finger #1, then finger #2. Poor quality prints are rejected — retry.
4. The template is generated on the terminal and uploaded securely; *Biometric Enrolment* shows the session live.

Supervisor PINs / linked fingerprints are managed in *Users & Roles → user → Supervisor credentials*.

## Devices
- **Device Registry** — Online / Offline / Warning / Pending activation, last heartbeat, firmware, roster version,
  buffered events, storage.
- **Add / Provision Device** — enter the device ID, choose the location, generate the activation code, enter it on the
  terminal, wait for verification, then **Activate**.
- **Device details → Actions** — sync roster, restart, refresh status, send configuration; firmware via *Firmware*.

## Alerts
Alert Center groups Critical / Warning / Info and Device / Sync / Integration. Each alert explains what happened, where,
the impact and the recommended action. Acknowledge while working on it, Resolve when done (with a note).

## Administration
Users & Roles (invite users, assign role and locations, require MFA), Integration & Sync (health, history, unmapped
locations), Audit Log (every change, tamper-evident, exportable), Settings (security, MFA, notifications, integration,
device policies, retention, system status).
