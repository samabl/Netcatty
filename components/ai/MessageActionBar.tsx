/**
 * Per-message action bar for the AI chat transcript.
 *
 * Rendered as a sibling of the message bubble (not inside it) so the copy /
 * edit / resend / branch controls never disturb bubble styling. The bar is
 * hidden until the message row is hovered or one of its controls is focused,
 * which also makes it keyboard reachable via tab.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, GitBranch, Pencil, RefreshCw } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import type { ChatMessageActionId } from '../../domain/chatMessageActions';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const COPY_FEEDBACK_MS = 1500;

const ACTION_LABEL_KEYS: Record<ChatMessageActionId, string> = {
  copy: 'ai.chat.messageAction.copy',
  edit: 'ai.chat.messageAction.edit',
  resend: 'ai.chat.messageAction.resend',
  branch: 'ai.chat.messageAction.branch',
};

export interface MessageActionBarProps {
  actions: ChatMessageActionId[];
  /** Side the bar hugs: user bubbles are right-aligned. */
  align?: 'start' | 'end';
  /** The message is currently being edited in the composer. */
  isEditing?: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onResend: () => void;
  onBranch: () => void;
}

const ACTION_ICONS: Record<ChatMessageActionId, React.ComponentType<{ size?: number; className?: string }>> = {
  copy: Copy,
  edit: Pencil,
  resend: RefreshCw,
  branch: GitBranch,
};

export const MessageActionBar: React.FC<MessageActionBarProps> = ({
  actions,
  align = 'start',
  isEditing = false,
  onCopy,
  onEdit,
  onResend,
  onBranch,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const handleAction = useCallback((action: ChatMessageActionId) => {
    switch (action) {
      case 'copy':
        onCopy();
        setCopied(true);
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        return;
      case 'edit':
        onEdit();
        return;
      case 'resend':
        onResend();
        return;
      case 'branch':
        onBranch();
        return;
      default:
        return;
    }
  }, [onBranch, onCopy, onEdit, onResend]);

  if (actions.length === 0) return null;

  return (
    <div
      data-ai-message-actions=""
      className={cn(
        'flex h-5 items-center gap-0.5 px-0.5 transition-opacity',
        // Pointer users reveal the bar on row hover; keyboard users on focus.
        // The row keeps its height while hidden so revealing it never shifts
        // the transcript.
        'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      {actions.map((action) => {
        const Icon = action === 'copy' && copied ? Check : ACTION_ICONS[action];
        const label = t(ACTION_LABEL_KEYS[action]);
        return (
          <Tooltip key={action}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                data-ai-message-action={action}
                onClick={() => handleAction(action)}
                className={cn(
                  'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
                  'text-muted-foreground/45 hover:bg-white/[0.06] hover:text-foreground',
                  action === 'edit' && isEditing && 'bg-primary/[0.10] text-primary',
                  action === 'copy' && copied && 'text-emerald-500 hover:text-emerald-500',
                )}
              >
                <Icon size={11} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};

export default MessageActionBar;
