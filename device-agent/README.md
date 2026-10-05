# BAMP device agent

This is the software that runs on each biometric attendance terminal. It works offline first:

- It keeps a full local copy of the branch roster, the supervisors and the fingerprint templates.
- It identifies people and records attendance with no network needed at capture time (NFR-2.1: the decision takes less than 5 s).
- Every event is written to a durable SQLite store before any network send (WAL, `synchronous=FULL`).
- When a connection is available, each event goes out at once over MQTT/TLS.
- Anything not yet acknowledged is uploaded over signed HTTPS in batches, oldest first.

It also handles on-device enrolment with supervisor authorisation, heartbeats, remote commands, log upload and over-the-air (OTA) updates.

```
src/
  cli.ts          activate | run | status | reset | self-test
  agent.ts        wires the services together
  store.ts        SQLite: identity/kv, roster, supervisors, templates, attendance buffer, log buffer, firmware state
  http.ts         signed HTTPS client (HMAC-SHA256, timestamp + nonce, custom CA, retry/backoff)
  mqttLink.ts     mqtts link: presence LWT, commands, roster-changed, attendance/ack
  sync.ts         roster / supervisors / templates delta sync (?since=), full resync
  library.ts      keeps the sensor's template library in step with the store (employee+finger ↔ slot)
  capture.ts      attendance decision + durable write + real-time publish
  uploader.ts     HTTPS batch uploader / reconciliation
  heartbeat.ts    health over MQTT (HTTPS fallback), storage alarm
  enrolment.ts    supervisor-authorised enrolment sessions
  commands.ts     sync_roster, refresh_status, send_config, restart, update_firmware, rollback_firmware
  firmware.ts     OTA download / verify / stage / launch / verify / rollback
  logs.ts         pino → local file + log buffer → POST /device/v1/logs
  terminal.ts     kiosk text UI
  sensors/        FingerprintSensor interface, ZFM/R30x/AS608 UART driver, console bench driver
service/          systemd unit, Windows scheduled-task installer, run-forever.cmd supervisor loop
```

## 1. Wiring the fingerprint sensor (R30x / ZFM-20 / AS608 family)

The module speaks a UART protocol at **57600 baud, 8N1** (the factory default). Connect it to a TTL-level serial port:

- On a Linux board, use the SoC UART, for example `/dev/ttyS0`, `/dev/ttyAMA0` or `/dev/serial0`.
- On a PC, use a USB-TTL adapter (CP2102, CH340 or FTDI). It shows up as `COMx` on Windows or `/dev/ttyUSB0` on Linux.

| Module wire (typical colour)  | Connect to |
|-------------------------------|------------|
| VCC (red)                     | 3.3 V for R307S/R503/AS608 boards. 5 V only for modules marked 5 V (classic R305/R307). Check the label. |
| GND (black)                   | GND |
| TX (yellow/green)             | **RX** of the board/adapter |
| RX (white/blue)               | **TX** of the board/adapter |
| WAKEUP / 3.3VT (if present)   | Leave unconnected, or tie to 3.3 V on R503 |

- TX and RX are **crossed**. If the agent logs `No response from the fingerprint module`, swap them first.
- The UART is 3.3 V TTL. Never connect it directly to an RS-232 (±12 V) port.
- On Raspberry Pi, turn off the serial login console (`raspi-config` → Interface → Serial: login shell *No*, hardware *Yes*).
- On Linux, the service user needs the `dialout` group.

Configure the port in `.env`:

```
SENSOR_DRIVER=serial
SENSOR_PORT=/dev/ttyS0          # or COM3
SENSOR_BAUD=57600
# SENSOR_ADDRESS=FFFFFFFF       # module address (default)
# SENSOR_PASSWORD=00000000      # module password (default)
# SENSOR_SCORE_SCALE=150        # raw module score that maps to 100 on the platform scale
```

How the driver maps sensor scores to platform scores:

- **Identification:** `Search` returns a raw match score. It is scaled to 0–100 (`raw × 100 / SENSOR_SCORE_SCALE`) and compared with the platform policy `minMatchScore` (default 60).
- **Enrolment quality:** both presses must convert successfully (`Img2Tz`), and the two captures must agree. The `Match` score between them is scaled the same way and compared with `minEnrolQuality`.
- **Tuning:** if genuine fingers are often rejected, raise `SENSOR_SCORE_SCALE` a little, or lower the policy.

The module's own library (pages `0 … librarySize-1`, read with `ReadSysPara`) holds the templates used for 1:N search. The agent stores which employee and finger sits on which page. If the module is swapped or wiped, the agent notices that the template count differs and reloads the library from the local store.

### Bench mode (no sensor attached)

`SENSOR_DRIVER=console` runs the whole pipeline without hardware. **It is not for production.** The logs and the status line say so.

- **Scanning:** press Enter, then type the staff number of the person "at the terminal". You can add a finger number, for example `S1024#7`. To authorise with a supervisor fingerprint whose linked employee is not on this branch's roster, type the employee UUID.
- **Templates:** each template is `HMAC-SHA256(device-local secret, employeeId:finger)`. The secret is in `DATA_DIR/bench-sensor.key`. So enrol → upload → sync down → identify round-trips on the same terminal.
- **Enrolment:** the "capture" asks for a quality value, which lets you test the too-low-quality path.
- **Console required:** bench mode needs an interactive console (it cannot run headless).

## 2. Install

This needs Node.js 22.

```bash
cd device-agent
npm ci          # or npm install
npm run build
cp .env.example .env   # then edit it
```

When you develop against the local platform, `node scripts/setup-local.mjs` writes `device-agent/.env` for you. It sets the API URL, the CA file, the data directory and the console sensor. Add `BAMP_DEVICE_UID=<uid>` to it.

## 3. Activation (one time per terminal)

1. In the dashboard, go to **Devices → Register** and create the device (UID + location). Then choose **Issue credentials**. You get a one-time activation code, which is valid for 72 h.
2. On the terminal, run:

   ```bash
   node dist/cli.js activate --uid BR-LAG-001 --code 7KQ4-M2XP-9RTA --api https://bamp.example.com
   # or: npm run activate -- --uid BR-LAG-001 --code 7KQ4-M2XP-9RTA
   ```

   The first request is validated with `BAMP_CA_FILE` (or the OS trust store). The response contains:
   - the device's own HMAC secret (NFR-1.3),
   - its MQTT username and password,
   - the MQTT CA certificate,
   - the topic prefix and the organisation id.

   These are stored in `DATA_DIR/device.db`. On Linux the directory is restricted to mode 0700 and the files to 0600. On Windows, an ACL limits it to SYSTEM, Administrators and the activating user. From then on, MQTT and HTTPS validate the server against the delivered CA.
3. Start the agent. Its first heartbeat moves the device to *Connected*. An administrator then verifies and **activates** it in the dashboard. The platform sends `send_config`, and the device becomes *Active*. Only *Active* devices with a location may enrol fingerprints.

## 4. Running

```bash
node dist/cli.js run        # production (npm start)
npm run dev                 # from sources with tsx
node dist/cli.js status     # identity, versions, buffered events, storage, firmware
node dist/cli.js reset      # factory reset (asks for the UID; warns before discarding undelivered events)
```

Kiosk keys (on an interactive console):

| Key | Action |
|-----|--------|
| Enter | Scan a finger. With a real sensor, scanning is continuous: just place a finger. |
| I / O / A | Direction mode: In, Out, or Auto. Auto is the opposite of the employee's last punch today in the location's time zone; the first punch of the day is IN. |
| E | Enrolment: supervisor PIN or fingerprint → pick an employee from the roster → capture `fingersPerEmployee` fingers → upload |
| S | Full status |
| Q | Quit |

Sample output:

```
✔ Tunde Bakare (S1024)  IN   08:01:12  (score 87)
  Stored offline — will upload automatically
✖ Not recognised — please try again
```

### As a service

**Linux:** follow the header of `service/bamp-device.service`, then run `systemctl enable --now bamp-device`.

- The unit uses `Restart=always`.
- Exit code **75** means "restart requested". The agent uses it for the remote `restart` command and after installing or rolling back firmware.
- To show the kiosk UI on the attached screen, enable the `TTYPath` lines in the unit.

**Windows:** from an elevated PowerShell, run:

```powershell
powershell -ExecutionPolicy Bypass -File service\install-windows-service.ps1                 # headless, SYSTEM, at boot
powershell -ExecutionPolicy Bypass -File service\install-windows-service.ps1 -Mode Kiosk     # visible console at logon
powershell -ExecutionPolicy Bypass -File service\install-windows-service.ps1 -Uninstall
```

The scheduled task runs `service\run-forever.cmd`. That script restarts the agent at once on exit code 75, and after 5 s on any other exit. In kiosk mode, an operator's Q (exit 0) stops it.

## 5. How it talks to the platform

**HTTPS** (every request is signed, NFR-1.4):

- **Headers:** `X-Device-Id`, `X-Timestamp` (unix seconds), `X-Nonce` (24 random chars), and `X-Signature = hex HMAC-SHA256(secret, METHOD\nPATH?query\nTIMESTAMP\nNONCE\nsha256hex(body))`.
- **Clock skew:** the agent measures the offset from the server's `Date` header and `serverTime`, and applies it to signatures and capture timestamps.

**MQTT over TLS on 8883** (NFR-1.2), under `bamp/{org}/devices/{uid}/`:

- `presence` is retained. The last will is `{"state":"offline"}`, and the agent publishes `{"state":"online"}` on connect.
- The device publishes `heartbeat`, `attendance` (QoS 1), `enrolment`, `firmware` and `commands/ack`.
- It subscribes to `commands`, `roster-changed` and `attendance/ack`.

**Attendance** (FR-3, FR-4):

- Each event carries `eventUid = <uid>-<ULID>` (time-sortable, unique), `capturedAt` with the local offset, `tzOffsetMinutes`, `matchScore` and `fingerIndex`.
- It is stored first. Then it is published over MQTT if the link is up, and marked delivered when `attendance/ack` arrives.
- Every 5 s, the uploader sends anything pending, or sent more than 30 s ago without an ack, to `POST /device/v1/attendance/batch`. It sends `{events, remaining}` in batches of `uploadBatchSize`, oldest first. The platform deduplicates on `eventUid`.
- Reconciliation progress is logged, and reported in the heartbeat as `reconciling`.

**Storage** (FR-4.3):

- The capacity is `storageCapacityEvents`, 200 000 by default. You can override it with device config or `BAMP_STORAGE_CAPACITY_EVENTS`.
- When the store is full, the oldest *delivered* events are recycled first.
- Under the default policy (`continue_capturing_alert`), capture continues. Nothing undelivered is ever discarded, and the terminal and the heartbeat alarm loudly once usage passes the warning or critical thresholds.
- Under `preserve_oldest`, new captures are refused while the buffer is full of undelivered events.

**Roster sync:**

- A sync runs on start, on `roster-changed`, on `sync_roster`, and every 10 minutes.
- Supervisors, and supervisor fingerprints, change only through full template syncs. So a change in the supervisor list forces a full template resync.
- When employees are removed, their templates are deleted from the store and the sensor, unless the employee is a supervisor's linked record.

**OTA updates:**

- **Package format:** the firmware is a `.tgz` of this package, for example from `npm pack` after `npm run build`, containing `package.json` and `dist/`. If it has no `node_modules`, it shares the base installation's.
- **Download and verify:** the agent reports `downloading`, downloads `GET /device/v1/firmware/:targetId/blob`, and verifies the SHA-256. A mismatch reports `failed`, and the device keeps running.
- **Install:** it reports `installing`, unpacks to `DATA_DIR/firmware/<version>/`, and runs `self-test` on the new build. It then records the pending verification, reports `restarting`, and exits 75.
- **Start:** the base installation, started by the service, launches the staged version. That version reports `verified` once it is healthy.
- **Crash protection:** if a staged version fails to start 3 times, the launcher rolls back automatically and reports `rolled_back`.
- **Rollback command:** `rollback_firmware` switches to the retained previous version, or to the base installation.

## 6. Troubleshooting

| Symptom | What to check |
|---------|---------------|
| `No response from the fingerprint module on …` | Swap TX/RX. Check the supply voltage and `SENSOR_BAUD` (57600). Check that nothing else holds the port (serial console, another agent). |
| `Cannot open COM3` / `/dev/ttyS0` | Check the port name (`mode` on Windows, `ls /dev/tty*` on Linux). On Linux, the user must be in `dialout`. |
| `Activation code invalid, expired, or device not provisioned` | Codes are single-use and expire after 72 h. Issue new credentials in the dashboard. |
| `unable to verify the first certificate` / `self signed certificate` | Set `BAMP_CA_FILE` to the platform CA (on a dev machine, `bamp-runtime/pki/ca.crt`). |
| `401 stale_request` repeatedly | The terminal clock is far off. The agent corrects the offset automatically after a successful response. Enable NTP. |
| `401 Bad signature` | The device was re-issued credentials. Run `reset` and activate again. |
| Status shows `OFFLINE`, pending events growing | Nothing is lost. Events upload automatically when HTTPS is reachable again. `status` shows the counts. |
| `Enrolment is not permitted on this device` | The device must be *Active* and assigned to a location in the dashboard. |
| `Employee unavailable` during enrolment | The employee is not on this location's roster. Terminals never create employees; add them in the web software. The roster syncs automatically. |
| `Fingerprint quality too low` | Clean the sensor glass. Press the finger flat, and use the same finger for both presses. For dry fingers, breathe on the finger. |
| Templates count differs from the sensor | This is automatic. The library is reloaded from the store when the counts differ. |
| Logs | `DATA_DIR/logs/agent.log` (rotated at 10 MB). Uploaded to the dashboard every 60 s. |
