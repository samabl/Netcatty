import React, { useCallback, useMemo, useState } from 'react';
import { Plus, RefreshCcw, Trash2 } from 'lucide-react';

import { useI18n } from '../../../../application/i18n/I18nProvider';
import {
  createExternalMcpServerDraft,
  useExternalMcpServersState,
} from '../../../../application/state/useExternalMcpServersState';
import {
  EXTERNAL_MCP_TRANSPORTS,
  type ExternalMcpServer,
  type ExternalMcpTransport,
} from '../../../../domain/mcp/externalMcpServer';
import { cn } from '../../../../lib/utils';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';
import { Input } from '../../../ui/input';
import { Textarea } from '../../../ui/textarea';
import { Select, SettingCard, SettingHint, SettingRow, Toggle } from '../../settings-ui';
import {
  EXTERNAL_MCP_VALIDATION_MESSAGE_KEY,
  createEmptyFormValues,
  fromFormValues,
  toFormValues,
  validateFormValues,
  type ExternalMcpFormValues,
} from './externalMcpForm';

const STATUS_TONE: Record<string, string> = {
  connected: 'text-emerald-500',
  connecting: 'text-amber-500',
  disabled: 'text-muted-foreground',
  error: 'text-destructive',
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="space-y-1.5">
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    {children}
    {hint ? <div className="text-xs text-muted-foreground/80">{hint}</div> : null}
  </div>
);

/**
 * Editor for the third-party MCP servers the in-app agent may call.
 *
 * Every call still passes through the shared approval gate: observer mode
 * denies these tools and confirm mode asks the user unless the server opted
 * into auto-approval.
 */
export const ExternalMcpServersCard: React.FC = () => {
  const { t } = useI18n();
  const {
    servers,
    statuses,
    isLoading,
    isBridgeAvailable,
    addServer,
    updateServer,
    removeServer,
    setServerEnabled,
    refreshStatuses,
  } = useExternalMcpServersState();

  const [editing, setEditing] = useState<ExternalMcpFormValues | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<ExternalMcpServer | null>(null);

  const statusById = useMemo(() => {
    const map = new Map<string, (typeof statuses)[number]>();
    for (const status of statuses) map.set(status.id, status);
    return map;
  }, [statuses]);

  const startAdd = useCallback(() => {
    setEditing(createEmptyFormValues(createExternalMcpServerDraft().id));
    setIsNew(true);
    setErrors([]);
  }, []);

  const startEdit = useCallback((server: ExternalMcpServer) => {
    setEditing(toFormValues(server));
    setIsNew(false);
    setErrors([]);
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setIsNew(false);
    setErrors([]);
  }, []);

  const patch = useCallback((changes: Partial<ExternalMcpFormValues>) => {
    setEditing((current) => (current ? { ...current, ...changes } : current));
  }, []);

  const save = useCallback(() => {
    if (!editing) return;
    const validation = validateFormValues(editing);
    if (validation.length > 0) {
      setErrors(validation.map((code) => t(EXTERNAL_MCP_VALIDATION_MESSAGE_KEY[code])));
      return;
    }
    const server = fromFormValues(editing);
    if (isNew) addServer(server);
    else updateServer(server);
    closeEditor();
  }, [addServer, closeEditor, editing, isNew, t, updateServer]);

  const transportOptions = EXTERNAL_MCP_TRANSPORTS.map((transport) => ({
    value: transport,
    label: t(`ai.mcpServers.transport.${transport}`),
  }));

  return (
    <SettingCard divided>
      <div className="flex items-start justify-between gap-4 py-3">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t('ai.mcpServers.description')}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refreshStatuses()} disabled={isLoading}>
            <RefreshCcw size={14} />
          </Button>
          <Button size="sm" onClick={startAdd}>
            <Plus size={14} className="mr-1.5" />
            {t('ai.mcpServers.add')}
          </Button>
        </div>
      </div>

      <div className="space-y-3 py-3">
        {servers.length === 0 && !editing ? (
          <div className="text-sm text-muted-foreground">{t('ai.mcpServers.empty')}</div>
        ) : null}

        {servers.map((server) => {
          const status = statusById.get(server.id);
          const state = status?.state ?? (server.enabled ? 'connecting' : 'disabled');
          return (
            <div
              key={server.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{server.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {server.transport}
                  </span>
                </div>
                <div className={cn('text-xs', STATUS_TONE[state] ?? 'text-muted-foreground')}>
                  {t(`ai.mcpServers.status.${state}`)}
                  {state === 'connected'
                    ? ` - ${t('ai.mcpServers.toolCount', { count: String(status?.toolCount ?? 0) })}`
                    : ''}
                </div>
                {status?.error ? (
                  <div className="text-xs text-destructive break-words">{status.error}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Toggle
                  checked={server.enabled}
                  onChange={(next) => setServerEnabled(server.id, next)}
                  ariaLabel={server.name}
                />
                <Button variant="outline" size="sm" onClick={() => startEdit(server)}>
                  {t('ai.mcpServers.edit')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPendingDelete(server)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          );
        })}

        {editing ? (
          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="text-sm font-medium">
              {isNew ? t('ai.mcpServers.addTitle') : t('ai.mcpServers.editTitle')}
            </div>

            <Field label={t('ai.mcpServers.name')}>
              <Input
                value={editing.name}
                placeholder={t('ai.mcpServers.name.placeholder')}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>

            <Field label={t('ai.mcpServers.transport')}>
              <Select
                value={editing.transport}
                options={transportOptions}
                onChange={(value) => patch({ transport: value as ExternalMcpTransport })}
                className="w-64"
              />
            </Field>

            {editing.transport === 'stdio' ? (
              <>
                <Field label={t('ai.mcpServers.command')}>
                  <Input
                    value={editing.command}
                    placeholder={t('ai.mcpServers.command.placeholder')}
                    onChange={(event) => patch({ command: event.target.value })}
                  />
                </Field>
                <Field label={t('ai.mcpServers.args')}>
                  <Textarea
                    className="min-h-[60px] font-mono text-xs"
                    value={editing.argsText}
                    placeholder={t('ai.mcpServers.args.placeholder')}
                    onChange={(event) => patch({ argsText: event.target.value })}
                  />
                </Field>
                <Field label={t('ai.mcpServers.cwd')}>
                  <Input
                    value={editing.cwd}
                    placeholder={t('ai.mcpServers.cwd.placeholder')}
                    onChange={(event) => patch({ cwd: event.target.value })}
                  />
                </Field>
                <Field label={t('ai.mcpServers.env')} hint={t('ai.mcpServers.secretsNote')}>
                  <Textarea
                    className="min-h-[60px] font-mono text-xs"
                    value={editing.envText}
                    placeholder={t('ai.mcpServers.env.placeholder')}
                    onChange={(event) => patch({ envText: event.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={t('ai.mcpServers.url')}>
                  <Input
                    value={editing.url}
                    placeholder={t('ai.mcpServers.url.placeholder')}
                    onChange={(event) => patch({ url: event.target.value })}
                  />
                </Field>
                <Field label={t('ai.mcpServers.headers')} hint={t('ai.mcpServers.secretsNote')}>
                  <Textarea
                    className="min-h-[60px] font-mono text-xs"
                    value={editing.headersText}
                    placeholder={t('ai.mcpServers.headers.placeholder')}
                    onChange={(event) => patch({ headersText: event.target.value })}
                  />
                </Field>
              </>
            )}

            <Field label={t('ai.mcpServers.toolAllowlist')}>
              <Textarea
                className="min-h-[50px] font-mono text-xs"
                value={editing.toolAllowlistText}
                placeholder={t('ai.mcpServers.toolAllowlist.placeholder')}
                onChange={(event) => patch({ toolAllowlistText: event.target.value })}
              />
            </Field>

            <SettingRow
              label={t('ai.mcpServers.autoApprove')}
              description={t('ai.mcpServers.autoApprove.description')}
            >
              <Toggle
                checked={editing.autoApprove}
                onChange={(next) => patch({ autoApprove: next })}
                ariaLabel={t('ai.mcpServers.autoApprove')}
              />
            </SettingRow>

            {errors.length > 0 ? (
              <div className="space-y-1 text-xs text-destructive">
                {errors.map((message) => <div key={message}>{message}</div>)}
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={closeEditor}>
                {t('ai.mcpServers.cancel')}
              </Button>
              <Button size="sm" onClick={save}>
                {t('ai.mcpServers.save')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {!isBridgeAvailable ? (
        <SettingHint>{t('ai.mcpServers.bridgeUnavailable')}</SettingHint>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? t('ai.mcpServers.confirmDelete', { name: pendingDelete.name }) : ''}
        confirmLabel={t('ai.mcpServers.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) removeServer(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </SettingCard>
  );
};
