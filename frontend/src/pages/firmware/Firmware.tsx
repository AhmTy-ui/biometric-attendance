import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Button,
  CopyButton,
  Empty,
  ErrorState,
  Icon,
  LinkButton,
  Loading,
  PageHeader,
  Panel,
  Progress,
  Table,
  Td,
  Th,
  THead,
  Tr
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { bytes, date, dateTime, num, pct, relative } from '@/lib/format';
import { ChannelBadge, chartTheme, DeploymentStatusBadge, IN_FLIGHT, shortSha, StatesBar, statesText, UploadFirmwareModal } from './components';

const UNKNOWN = 'Unknown';

export default function Firmware() {
  const { can } = useAuth();
  const nav = useNavigate();
  const canManage = can('firmware.manage');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [openNotes, setOpenNotes] = useState<string | null>(null);

  const versionsQ = useQuery({ queryKey: ['firmware-versions'], queryFn: () => api.get<any[]>('/api/firmware/versions') });
  const deploymentsQ = useQuery({ queryKey: ['firmware-deployments'], queryFn: () => api.get<any[]>('/api/firmware/deployments') });
  const devicesQ = useQuery({ queryKey: ['devices', { limit: 1000 }], queryFn: () => api.get<any>('/api/devices', { limit: 1000 }) });

  const versions: any[] = versionsQ.data ?? [];
  const deployments: any[] = deploymentsQ.data ?? [];
  const devices: any[] = devicesQ.data?.rows ?? [];
  const deviceTotal: number = devicesQ.data?.total ?? devices.length;

  const latestStable = versions.find((v) => v.channel === 'stable') ?? null;
  const knownVersions = useMemo(() => new Set(versions.map((v) => v.version)), [versions]);

  // Fleet firmware distribution (grouped from the device registry).
  const distribution = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of devices) {
      const k = d.firmware_version || UNKNOWN;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count);
  }, [devices]);

  const onLatest = latestStable ? devices.filter((d) => d.firmware_version === latestStable.version).length : 0;
  const active = deployments.filter((d) => d.status === 'in_progress');
  const inFlightTargets = active.reduce((a, d) => a + IN_FLIGHT.reduce((s, k) => s + (d.states?.[k] ?? 0), 0), 0);
  const failedTargets = active.reduce((a, d) => a + (d.states?.failed ?? 0), 0);

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        icon="system_update"
        title="Firmware & OTA Updates"
        subtitle="Upload firmware versions, deploy them to devices and monitor installation. Devices keep their previous firmware if an installation fails."
        actions={
          canManage && (
            <>
              <Button icon="cloud_upload" onClick={() => setUploadOpen(true)}>
                Upload version
              </Button>
              <LinkButton to="/firmware/deploy" variant="primary" icon="play_circle">
                New deployment
              </LinkButton>
            </>
          )
        }
      />

      {/* KPI grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-space-md">
        <Kpi
          label="Latest stable"
          icon="verified"
          iconCls="text-tertiary"
          value={latestStable ? latestStable.version : '—'}
          suffix={latestStable ? `${num(onLatest)} / ${num(deviceTotal)} devices` : 'No stable version uploaded'}
          left={latestStable ? `${pct(deviceTotal ? (onLatest / deviceTotal) * 100 : 0)} of fleet` : ''}
          right={latestStable ? `uploaded ${date(latestStable.created_at)}` : ''}
          bar={deviceTotal ? (onLatest / deviceTotal) * 100 : 0}
          barCls="bg-tertiary"
          loading={versionsQ.isLoading || devicesQ.isLoading}
        />
        <Kpi
          label="Versions in fleet"
          icon="account_tree"
          iconCls="text-secondary"
          value={num(distribution.length)}
          suffix="distinct versions"
          left={`${num(distribution.filter((d) => d.version !== UNKNOWN && !knownVersions.has(d.version)).length)} not in registry`}
          right={`${num(devices.filter((d) => !d.firmware_version).length)} unreported`}
          loading={devicesQ.isLoading || versionsQ.isLoading}
        />
        <Kpi
          label="Firmware registry"
          icon="inventory_2"
          iconCls="text-primary"
          value={num(versions.length)}
          suffix="uploaded versions"
          left={`${num(versions.filter((v) => v.channel === 'stable').length)} stable`}
          right={`${num(versions.filter((v) => v.channel === 'beta').length)} beta`}
          loading={versionsQ.isLoading}
        />
        <Kpi
          label="Active deployments"
          icon="sync"
          iconCls={failedTargets ? 'text-error' : 'text-secondary'}
          value={num(active.length)}
          suffix="in progress"
          left={`${num(inFlightTargets)} devices updating`}
          right={failedTargets ? `${num(failedTargets)} failed` : 'no failures'}
          rightCls={failedTargets ? 'text-error' : 'text-tertiary'}
          loading={deploymentsQ.isLoading}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md">
        {/* Left column */}
        <div className="xl:col-span-8 flex flex-col gap-space-md min-w-0">
          {/* Deployments */}
          <Panel
            title="Deployments"
            icon="alt_route"
            subtitle="Most recent 200 deployments"
            bodyClassName="px-0 pb-0"
            actions={
              canManage && (
                <LinkButton to="/firmware/deploy" size="sm" icon="add">
                  New deployment
                </LinkButton>
              )
            }
          >
            {deploymentsQ.isLoading ? (
              <Loading label="Loading deployments…" />
            ) : deploymentsQ.error && !deploymentsQ.data ? (
              <ErrorState error={deploymentsQ.error} onRetry={() => deploymentsQ.refetch()} />
            ) : !deployments.length ? (
              <Empty icon="alt_route" title="No deployments yet." description="Create a deployment to install a firmware version on selected devices." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Deployment</Th>
                    <Th>Version</Th>
                    <Th className="min-w-[200px]">Progress</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                  </tr>
                </THead>
                <tbody>
                  {deployments.map((d) => {
                    const total = d.target_count ?? 0;
                    const verified = d.states?.verified ?? 0;
                    return (
                      <Tr key={d.id} onClick={() => nav(`/firmware/deployments/${d.id}`)}>
                        <Td>
                          <div className="font-semibold text-on-surface">{d.name}</div>
                          <div className="font-label-sm text-label-sm text-outline">{num(total)} target devices</div>
                        </Td>
                        <Td className="font-mono text-on-surface">{d.version}</Td>
                        <Td>
                          <StatesBar states={d.states} total={total} />
                          <div className="mt-1 flex items-center justify-between gap-2 font-label-sm text-label-sm text-outline">
                            <span className="truncate">{statesText(d.states)}</span>
                            <span className="text-on-surface-variant shrink-0">{pct(total ? (verified / total) * 100 : 0, 0)}</span>
                          </div>
                        </Td>
                        <Td>
                          <DeploymentStatusBadge status={d.status} />
                        </Td>
                        <Td>
                          <div className="text-on-surface">{relative(d.created_at)}</div>
                          <div className="font-label-sm text-label-sm text-outline">{d.created_by_name ?? '—'}</div>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>

          {/* Version registry */}
          <Panel title="Firmware versions" icon="inventory_2" subtitle="SHA-256 checksums are verified by each device before installation" bodyClassName="px-0 pb-0">
            {versionsQ.isLoading ? (
              <Loading label="Loading firmware versions…" />
            ) : versionsQ.error && !versionsQ.data ? (
              <ErrorState error={versionsQ.error} onRetry={() => versionsQ.refetch()} />
            ) : !versions.length ? (
              <Empty
                icon="inventory_2"
                title="No firmware versions uploaded."
                description="Upload a firmware file to make it available for deployment."
                action={
                  canManage && (
                    <Button icon="cloud_upload" onClick={() => setUploadOpen(true)}>
                      Upload version
                    </Button>
                  )
                }
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Version</Th>
                    <Th>SHA-256</Th>
                    <Th>Installed on</Th>
                    <Th>Channel</Th>
                    <Th>Uploaded</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </THead>
                <tbody>
                  {versions.map((v) => {
                    const isLatest = latestStable?.id === v.id;
                    return (
                      <Fragment key={v.id}>
                        <Tr key={v.id} className={isLatest ? 'bg-surface-container/20' : undefined}>
                          <Td>
                            <div className="flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full ${v.installed_on > 0 ? (isLatest ? 'bg-tertiary' : 'bg-secondary') : 'bg-outline'}`} />
                              <span className="font-label-lg text-label-lg font-semibold text-on-surface">{v.version}</span>
                              {isLatest && <Badge tone="success">Latest stable</Badge>}
                            </div>
                            <span className="font-label-sm text-label-sm text-outline">
                              {v.file_name} • {bytes(Number(v.size_bytes))}
                            </span>
                          </Td>
                          <Td>
                            <div className="font-label-sm text-label-sm text-secondary font-mono" title={v.sha256}>
                              {shortSha(v.sha256)}
                            </div>
                          </Td>
                          <Td>
                            <span className={`font-label-sm text-label-sm ${v.installed_on > 0 ? 'text-on-surface font-semibold' : 'text-outline'}`}>{num(v.installed_on)} devices</span>
                          </Td>
                          <Td>
                            <ChannelBadge channel={v.channel} />
                          </Td>
                          <Td>
                            <div className="text-on-surface">{dateTime(v.created_at)}</div>
                            <div className="font-label-sm text-label-sm text-outline">{v.uploaded_by_name ?? '—'}</div>
                          </Td>
                          <Td className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button size="sm" variant="ghost" icon={openNotes === v.id ? 'expand_less' : 'description'} onClick={() => setOpenNotes(openNotes === v.id ? null : v.id)}>
                                Details
                              </Button>
                              {canManage && (
                                <LinkButton size="sm" variant="subtle" icon="play_arrow" to={`/firmware/deploy?firmwareId=${v.id}`}>
                                  Deploy
                                </LinkButton>
                              )}
                            </div>
                          </Td>
                        </Tr>
                        {openNotes === v.id && (
                          <tr key={`${v.id}-notes`} className="bg-surface-container-lowest/60">
                            <Td colSpan={6}>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md py-1">
                                <div className="md:col-span-2">
                                  <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider mb-1">Release notes</div>
                                  <p className="text-body-sm text-on-surface-variant whitespace-pre-wrap">{v.release_notes || 'No release notes provided.'}</p>
                                </div>
                                <div className="flex flex-col gap-1 min-w-0">
                                  <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider">SHA-256</div>
                                  <code className="font-mono text-[11px] text-on-surface-variant break-all">{v.sha256}</code>
                                  <div>
                                    <CopyButton value={v.sha256} label="Copy checksum" />
                                  </div>
                                </div>
                              </div>
                            </Td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        {/* Right column: fleet distribution */}
        <div className="xl:col-span-4 flex flex-col gap-space-md min-w-0">
          <Panel title="Fleet firmware distribution" icon="memory" subtitle={`${num(devices.length)} registered devices`}>
            {devicesQ.isLoading ? (
              <Loading label="Loading devices…" />
            ) : devicesQ.error && !devicesQ.data ? (
              <ErrorState error={devicesQ.error} onRetry={() => devicesQ.refetch()} compact />
            ) : !distribution.length ? (
              <Empty icon="router" title="No devices registered." />
            ) : (
              <div className="flex flex-col gap-space-md">
                <div style={{ height: Math.max(120, distribution.length * 34 + 30) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={distribution} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 0 }} barCategoryGap={6}>
                      <CartesianGrid horizontal={false} stroke={chartTheme.grid} strokeOpacity={0.4} />
                      <XAxis type="number" allowDecimals={false} tick={chartTheme.tick} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="version" width={90} tick={chartTheme.tick} axisLine={false} tickLine={false} />
                      <Tooltip {...chartTheme.tooltip} formatter={(v: any) => [`${num(v)} devices`, 'Installed']} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={16}>
                        {distribution.map((d) => (
                          <Cell key={d.version} fill={d.version === latestStable?.version ? '#4edea3' : d.version === UNKNOWN ? '#8d90a0' : '#93ccff'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-col gap-2">
                  {distribution.map((d) => {
                    const share = devices.length ? (d.count / devices.length) * 100 : 0;
                    const inRegistry = d.version === UNKNOWN || knownVersions.has(d.version);
                    return (
                      <div key={d.version} className="p-space-sm bg-surface-container rounded">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-label-lg text-label-lg font-semibold text-on-surface truncate">{d.version}</span>
                            {d.version === latestStable?.version && <Badge tone="success">Latest</Badge>}
                            {!inRegistry && <Badge tone="warning">Not in registry</Badge>}
                          </div>
                          <span className="font-label-sm text-label-sm text-on-surface-variant shrink-0">
                            {num(d.count)} · {pct(share)}
                          </span>
                        </div>
                        <Progress value={share} tone={d.version === latestStable?.version ? 'success' : d.version === UNKNOWN ? 'neutral' : 'info'} />
                        {d.version !== UNKNOWN && (
                          <button className="mt-1 font-label-sm text-label-sm text-primary hover:underline" onClick={() => nav(`/devices?firmware=${encodeURIComponent(d.version)}`)}>
                            View devices
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {deviceTotal > devices.length && (
                  <p className="font-label-sm text-label-sm text-outline flex items-center gap-1">
                    <Icon name="info" className="text-[14px]" />
                    Showing the first {num(devices.length)} of {num(deviceTotal)} devices.
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel title="How updates are applied" icon="gavel">
            <ul className="space-y-space-sm font-body-sm text-body-sm text-on-surface-variant">
              <li className="flex items-start gap-2">
                <Icon name="task_alt" className="text-tertiary text-[16px] shrink-0 mt-0.5" />
                <span>Each device downloads the file and checks its SHA-256 checksum before installing.</span>
              </li>
              <li className="flex items-start gap-2">
                <Icon name="task_alt" className="text-tertiary text-[16px] shrink-0 mt-0.5" />
                <span>Offline devices receive the update when they reconnect.</span>
              </li>
              <li className="flex items-start gap-2">
                <Icon name="task_alt" className="text-tertiary text-[16px] shrink-0 mt-0.5" />
                <span>If installation fails the device stays on its previous firmware; you can Retry or Roll back from the deployment.</span>
              </li>
            </ul>
          </Panel>
        </div>
      </div>

      <UploadFirmwareModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </div>
  );
}

function Kpi({
  label,
  icon,
  iconCls,
  value,
  suffix,
  left,
  right,
  rightCls,
  bar,
  barCls,
  loading
}: {
  label: string;
  icon: string;
  iconCls: string;
  value: string;
  suffix: string;
  left: string;
  right: string;
  rightCls?: string;
  bar?: number;
  barCls?: string;
  loading?: boolean;
}) {
  return (
    <div className="p-space-md bg-surface-container-low rounded flex flex-col justify-between shadow-sm relative overflow-hidden hover:bg-surface-container transition-colors">
      <div className="flex items-center justify-between text-outline mb-space-xs">
        <span className="font-label-sm text-label-sm uppercase tracking-wider">{label}</span>
        <Icon name={icon} className={`${iconCls} text-[18px]`} />
      </div>
      {loading ? (
        <div className="h-10 flex items-center">
          <Icon name="progress_activity" className="animate-spin text-[18px] text-primary" />
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-space-xs min-w-0">
            <span className="font-headline-xl text-headline-xl text-on-surface tracking-tight truncate">{value}</span>
            <span className="font-label-lg text-label-lg text-outline truncate">{suffix}</span>
          </div>
          <div className="mt-space-sm flex items-center justify-between gap-2">
            <span className="font-label-sm text-label-sm text-on-surface-variant truncate">{left}</span>
            <span className={`font-label-sm text-label-sm truncate ${rightCls ?? 'text-outline'}`}>{right}</span>
          </div>
          {bar !== undefined && (
            <div className="w-full bg-surface-container-high h-1 rounded mt-2 overflow-hidden">
              <div className={`${barCls ?? 'bg-primary'} h-full rounded`} style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
