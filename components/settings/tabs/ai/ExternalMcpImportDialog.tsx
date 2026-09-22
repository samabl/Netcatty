import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';

import { useI18n } from '../../../../application/i18n/I18nProvider';
import {
  parseExternalMcpServerImport,
  type ExternalMcpImportAction,
  type ExternalMcpImportError,
  type ExternalMcpImportSkipReason,
} from '../../../../domain/mcp/externalMcpImport';
import type { ExternalMcpServer } from '../../../../domain/mcp/externalMcpServer';
import { Button } from '../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Textarea } from '../../../ui/textarea';
import { toast } from '../../../ui/toast';

const ERROR_MESSAGE_KEY: Record<ExternalMcpImportError, string> = {
  'invalid-json': 'ai.mcpServers.import.error.invalidJson',
  'unsupported-shape': 'ai.mcpServers.import.error.unsupportedShape',
};

const SKIP_MESSAGE_KEY: Record<ExternalMcpImportSkipReason, string> = {
  'invalid-entry': 'ai.mcpServers.import.skip.invalidEntry',
  'limit-reached': 'ai.mcpServers.import.skip.limitReached',
};

export interface ExternalMcpImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Configured servers, matched by name so an import updates them in place. */
  existingServers: readonly ExternalMcpServer[];
  onImport: (actions: ExternalMcpImportAction[]) => void;
}

/**
 * Paste-or-pick JSON importer for third-party MCP servers.
 *
 * Parsing is pure (domain/mcp/externalMcpImport), so this component only
 * previews the plan and hands it to the settings state hook. A name that
 * already exists becomes an in-place update; new names are appended. Imported
 * servers keep approval defaults: observer mode blocks them and confirm mode
 * still asks per call unless the JSON opted into auto-approve.
 */
export const ExternalMcpImportDialog: React.FC<ExternalMcpImportDialogProps> = ({
  open,
  onOpenChange,
  existingServers,
  onImport,
}) => {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setFileError(false);
  }, [open]);

  const result = useMemo(
    () => (text.trim() ? parseExternalMcpServerImport(text, { existing: existingServers }) : null),
    [existingServers, text],
  );
  const actions = useMemo(() => result?.actions ?? [], [result]);
  const skipped = useMemo(() => result?.skipped ?? [], [result]);
  const addedCount = useMemo(
    () => actions.filter((action) => action.kind === 'add').length,
    [actions],
  );
  const updatedCount = actions.length - addedCount;

  const handleFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text()
      .then((contents) => {
        setText(contents);
        setFileError(false);
      })
      .catch(() => setFileError(true));
  }, []);

  const confirm = useCallback(() => {
    if (actions.length === 0) return;
    onImport(actions);
    toast.success(t('ai.mcpServers.import.imported', { count: String(actions.length) }));
    onOpenChange(false);
  }, [actions, onImport, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('ai.mcpServers.import.title')}</DialogTitle>
          <DialogDescription>{t('ai.mcpServers.import.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            className="min-h-[180px] font-mono text-xs"
            value={text}
            placeholder={t('ai.mcpServers.import.placeholder')}
            aria-label={t('ai.mcpServers.import.title')}
            onChange={(event) => setText(event.target.value)}
          />

          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} className="mr-1.5" />
              {t('ai.mcpServers.import.chooseFile')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleFile}
            />
            {fileError ? (
              <span className="text-xs text-destructive">{t('ai.mcpServers.import.fileError')}</span>
            ) : null}
            {result?.error ? (
              <span className="text-xs text-destructive">{t(ERROR_MESSAGE_KEY[result.error])}</span>
            ) : null}
          </div>

          {actions.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t('ai.mcpServers.import.summary', {
                  added: String(addedCount),
                  updated: String(updatedCount),
                })}
              </div>
              <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-border/60 p-2">
                {actions.map((action) => (
                  <div key={action.server.id} className="flex items-center gap-2 text-xs">
                    <span className="truncate font-medium">{action.server.name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {action.kind === 'update'
                        ? t('ai.mcpServers.import.badge.update')
                        : t('ai.mcpServers.import.badge.add')}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {action.server.transport}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {action.server.command ?? action.server.url ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {skipped.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t('ai.mcpServers.import.skipped', { count: String(skipped.length) })}
              </div>
              <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-border/60 p-2 text-xs text-muted-foreground">
                {skipped.map((entry, index) => (
                  <div
                    key={String(index) + '-' + entry.name}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{entry.name || t('ai.mcpServers.import.unnamed')}</span>
                    <span className="shrink-0">{t(SKIP_MESSAGE_KEY[entry.reason])}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('ai.mcpServers.import.cancel')}
          </Button>
          <Button size="sm" disabled={actions.length === 0} onClick={confirm}>
            {t('ai.mcpServers.import.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
