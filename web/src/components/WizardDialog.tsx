/**
 * 向导弹窗 —— 复用 CLI 的向导定义（core/wizard-steps.mjs）
 *
 * 【为什么有这个东西】
 * 用户要求「不在 web 搞另一套 slash 了，复用 cli。有向导的也复用，在 web 也建向导」。
 *
 * CLI 的 runWizard 是终端交互（画 ANSI 边框 + 读 readline），Web 用不了。
 * 但向导的**内容**（steps 定义 + 落盘逻辑）是跨端的，抽在 core/wizard-steps.mjs。
 * 服务端通过 /api/wizards/<id> 把 steps 发给这里渲染，用户填完 POST 回去，
 * 服务端调同一个 apply() 落盘 —— 所以两端写出来的配置结构必然一致。
 *
 * 【steps 支持的形态】（与 core/wizard.mjs 的 runWizard 对齐）
 *   key/label       必填，字段名与显示名
 *   required        必填校验
 *   default         默认值
 *   hint/desc       提示文案
 *   options         枚举选项（radio 卡片）
 *   multi           多值（换行/空格分隔 → 数组）
 *   secret          密码框
 *   validate(v)     自定义校验，返回错误文案或 null
 *   when(answers)   条件显示（返回 false 则隐藏）
 */

import React, { useEffect, useMemo, useState } from 'react';
import { X, Check, Loader2 } from 'lucide-react';

export interface WizardStep {
  key: string;
  label: string;
  required?: boolean;
  default?: string;
  hint?: string;
  desc?: string;
  options?: Array<{ label: string; value: string; desc?: string }>;
  multi?: boolean;
  secret?: boolean;
  validate?: (value: any) => string | null;
  when?: (answers: Record<string, any>) => boolean;
}

interface Props {
  isOpen: boolean;
  wizardId: string;
  title: string;
  steps: WizardStep[];
  onClose: () => void;
  onDone: (message: string) => void;
}

const WizardDialog: React.FC<Props> = ({ isOpen, wizardId, title, steps, onClose, onDone }) => {
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');

  // 打开时灌默认值。用 wizardId 当依赖：换一个向导要重新初始化，
  // 否则上一个向导填了一半的内容会串过来。
  useEffect(() => {
    if (!isOpen) return;
    const init: Record<string, any> = {};
    for (const s of steps) {
      if (s.default !== undefined) init[s.key] = s.default;
      else if (s.multi) init[s.key] = [];
      else init[s.key] = '';
    }
    setAnswers(init);
    setErrors({});
    setServerError('');
  }, [isOpen, wizardId]);

  // when(answers) 返回 false 的步骤整步隐藏 —— 与 runWizard 的 enabled() 一致
  const visibleSteps = useMemo(
    () => steps.filter(s => (typeof s.when === 'function' ? safeWhen(s.when, answers) : true)),
    [steps, answers]
  );

  const setValue = (key: string, value: any) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
    // 改了就清掉这个字段的旧错误，不然用户改完了红字还挂着
    setErrors(prev => (prev[key] ? { ...prev, [key]: '' } : prev));
  };

  /** 前端先校验一遍（体验）；服务端还会再校验一遍（安全边界）。 */
  const validateAll = (): boolean => {
    const next: Record<string, string> = {};
    for (const s of visibleSteps) {
      const raw = answers[s.key];
      const empty = s.multi ? !Array.isArray(raw) || raw.length === 0 : !String(raw ?? '').trim();
      if (s.required && empty) {
        next[s.key] = `${s.label} 不能为空`;
        continue;
      }
      if (!empty && typeof s.validate === 'function') {
        const msg = safeValidate(s.validate, raw);
        if (msg) next[s.key] = msg;
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateAll()) return;
    setSubmitting(true);
    setServerError('');
    try {
      const res = await fetch(`/api/wizards/${encodeURIComponent(wizardId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 服务端指出哪个字段错就标哪个字段，别只弹个笼统错误
        if (data?.field) setErrors({ [data.field]: String(data.error || '校验失败') });
        else setServerError(String(data?.error || `提交失败（HTTP ${res.status}）`));
        return;
      }
      onDone(String(data?.message || '完成'));
      onClose();
    } catch (e: any) {
      setServerError(e?.message || '网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[520px] max-h-[85vh] flex flex-col rounded-[16px] bg-claude-bg border border-claude-border shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-claude-border shrink-0">
          <div className="text-[15px] font-semibold text-claude-text">{title}</div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-claude-hover text-claude-textSecondary"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表单主体 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {visibleSteps.map(step => (
            <div key={step.key}>
              <label className="block text-[13px] font-medium text-claude-text mb-1.5">
                {step.label}
                {step.required && <span className="text-[#E5484D] ml-1">*</span>}
              </label>

              {step.options ? (
                <div className="space-y-1.5">
                  {step.options.map(opt => {
                    const active = answers[step.key] === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setValue(step.key, opt.value)}
                        className={`w-full text-left px-3 py-2.5 rounded-[10px] border transition-colors ${
                          active
                            ? 'border-[#C6613F] bg-[#C6613F]/[0.06]'
                            : 'border-claude-border hover:bg-claude-hover'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-[13.5px] font-medium ${active ? 'text-[#C6613F]' : 'text-claude-text'}`}>
                            {opt.label}
                          </span>
                          {active && <Check size={14} className="text-[#C6613F]" />}
                        </div>
                        {opt.desc && (
                          <div className="text-[11.5px] text-claude-textSecondary mt-0.5">{opt.desc}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : step.multi ? (
                <textarea
                  value={Array.isArray(answers[step.key]) ? answers[step.key].join('\n') : ''}
                  onChange={e =>
                    setValue(
                      step.key,
                      // 空格和换行都当分隔符（与 runWizard 的 multi 行为一致）——
                      // 用户从别处粘一串 key 时，可能是空格分隔的
                      e.target.value.split(/[\s\n]+/).map(s => s.trim()).filter(Boolean)
                    )
                  }
                  placeholder={step.hint || ''}
                  rows={3}
                  className="w-full px-3 py-2 rounded-[10px] bg-black/[0.03] dark:bg-white/[0.05] border border-claude-border text-[13.5px] text-claude-text outline-none focus:border-[#C6613F] resize-y font-mono"
                />
              ) : (
                <input
                  type={step.secret ? 'password' : 'text'}
                  value={answers[step.key] ?? ''}
                  onChange={e => setValue(step.key, e.target.value)}
                  placeholder={step.hint || ''}
                  className="w-full px-3 py-2 rounded-[10px] bg-black/[0.03] dark:bg-white/[0.05] border border-claude-border text-[13.5px] text-claude-text outline-none focus:border-[#C6613F]"
                />
              )}

              {step.desc && !step.options && (
                <div className="text-[11.5px] text-claude-textSecondary mt-1">{step.desc}</div>
              )}
              {errors[step.key] && (
                <div className="text-[11.5px] text-[#E5484D] mt-1">{errors[step.key]}</div>
              )}
            </div>
          ))}

          {serverError && (
            <div className="text-[12px] text-[#E5484D] px-3 py-2 rounded-[10px] bg-[#E5484D]/[0.08]">
              {serverError}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-claude-border shrink-0">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 h-9 rounded-[10px] text-[13.5px] text-claude-textSecondary hover:bg-claude-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 h-9 rounded-[10px] text-[13.5px] font-medium bg-[#C6613F] text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? '提交中' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 用户自定义的 when/validate 可能抛错（比如引用了不存在的字段），
 *  不能让一个坏 step 把整个弹窗搞崩 —— 与 runWizard 的 try/catch 一致。 */
function safeWhen(fn: (a: any) => boolean, answers: Record<string, any>): boolean {
  try {
    return fn(answers) !== false;
  } catch {
    return true;
  }
}

function safeValidate(fn: (v: any) => string | null, value: any): string | null {
  try {
    return fn(value);
  } catch {
    return null;
  }
}

export default WizardDialog;
