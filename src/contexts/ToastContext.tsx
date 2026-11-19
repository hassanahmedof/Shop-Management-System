import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type ToastTone = 'warning' | 'error' | 'success' | 'info';

export interface ToastInput {
  id?: string;
  title: string;
  message: string;
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'id' | 'title' | 'message' | 'tone'>> {
  actionLabel?: string;
  onAction?: () => void;
  durationMs: number;
}

interface ToastContextValue {
  showToast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (input: ToastInput): string => {
      const id = input.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const tone: ToastTone = input.tone || 'info';
      const durationMs = input.durationMs ?? (tone === 'warning' || tone === 'error' ? 14000 : 7000);

      const existingTimer = timersRef.current.get(id);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        timersRef.current.delete(id);
      }

      const item: ToastItem = {
        id,
        title: input.title,
        message: input.message,
        tone,
        actionLabel: input.actionLabel,
        onAction: input.onAction,
        durationMs,
      };

      setToasts((prev) => [...prev.filter((t) => t.id !== id), item].slice(-4));

      if (durationMs > 0) {
        const timer = window.setTimeout(() => {
          dismissToast(id);
        }, durationMs);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismissToast]
  );

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const getToneVisuals = (tone: ToastTone) => {
    switch (tone) {
      case 'warning':
        return {
          icon: AlertTriangle,
          iconWrap: 'bg-amber-50 text-amber-700 border border-amber-200',
          titleColor: 'text-amber-900',
        };
      case 'error':
        return {
          icon: AlertCircle,
          iconWrap: 'bg-red-50 text-red-700 border border-red-200',
          titleColor: 'text-red-900',
        };
      case 'success':
        return {
          icon: CheckCircle2,
          iconWrap: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
          titleColor: 'text-emerald-900',
        };
      default:
        return {
          icon: Info,
          iconWrap: 'bg-teal-50 text-teal-700 border border-teal-200',
          titleColor: 'text-slate-900',
        };
    }
  };

  return (
    <ToastContext.Provider value={{ showToast, dismissToast, clearToasts }}>
      {children}
      {toasts.length > 0 && (
        <div
          className="fixed top-18 left-3 right-3 sm:left-auto sm:right-5 z-50 flex flex-col gap-2 sm:w-full sm:max-w-sm pointer-events-none"
          aria-live="polite"
          aria-label="Notifications"
        >
          {toasts.map((toast) => {
            const visuals = getToneVisuals(toast.tone);
            const Icon = visuals.icon;
            return (
              <div
                key={toast.id}
                role={toast.tone === 'error' || toast.tone === 'warning' ? 'alert' : 'status'}
                className="pointer-events-auto bg-white border border-slate-200 rounded-xl shadow-lg p-4 flex items-start gap-3"
              >
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${visuals.iconWrap}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className={`text-sm font-semibold leading-5 ${visuals.titleColor}`}>
                      {toast.title}
                    </h3>
                    <button
                      type="button"
                      onClick={() => dismissToast(toast.id)}
                      className="p-1 -mr-1 -mt-1 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
                      aria-label="Dismiss notification"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">{toast.message}</p>
                  {toast.actionLabel && toast.onAction && (
                    <div className="pt-1 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          toast.onAction?.();
                          dismissToast(toast.id);
                        }}
                        className="inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors cursor-pointer"
                      >
                        {toast.actionLabel}
                      </button>
                      <button
                        type="button"
                        onClick={() => dismissToast(toast.id)}
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
