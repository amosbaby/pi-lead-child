import type { ModelSettingsDto } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

/**
 * Lead 的会话此刻挂着的模型（provider/id，模型目录的 inSession，模型配置方案 C 的 S4）。
 * 一种订阅有几个账号时，pi-multi-pass 在 pool 里自己换号，设置的 DTO 只写分工的格子；这里问一次目录，订阅行据此标「正在用」。
 * 设置的 DTO 变了（登录、换号方式、分工）时再问一次。旧 daemon 不给 inSession，或者问不到时为 null：订阅行退回只按 DTO 判断。
 */
export function useInSessionModel(dto: ModelSettingsDto): string | null {
  const runtime = useCompanionRuntime();
  const [inSession, setInSession] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => runtime.loadLeadModels()).then(
      (catalog) => { if (current) setInSession(catalog.inSession ?? null); },
      () => { if (current) setInSession(null); },
    );
    return () => { current = false; };
  }, [runtime, dto]);
  return inSession;
}
