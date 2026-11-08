/**
 * KnowledgeTextAssembler — finalKnowledgeText 22 段注入链路装配器
 *
 * 🔴 B-2: 将 chat.ts 中约 275 行内联注入逻辑迁移为有序 Builder 模式。
 * 每个注入点为独立方法，build() 方法按硬编码固定顺序拼接。
 *
 * 🚨 全局规则 9: 22 段注入顺序不可调换——prepend/append 操作在 build() 内部按固定优先级排序。
 * 🚨 全局规则 3: PFC 为唯一顶层门控——Assembler 不替代 PFC，仅在 PFC 输出后进行文本拼接。
 *
 * 设计: 有序缓冲区——prepend 在第一优先级，setBody 在第二，append 在第三。
 *       同优先级内按调用先后顺序排列。
 */

export class KnowledgeTextAssembler {
  /** 前置段（最高优先级，最早出现） */
  private _prepends: string[] = [];
  /** 主体文本（中等优先级） */
  private _body: string = '';
  /** 后置段（最低优先级，最后出现） */
  private _appends: string[] = [];

  // ── 基础方法 ──

  /** 设置主体文本 */
  setBody(text: string): this {
    this._body = text;
    return this;
  }

  /** 前置注入（文本会被放在主体之前） */
  prepend(text: string): this {
    if (text) this._prepends.unshift(text);
    return this;
  }

  /** 后置注入（文本会被放在主体之后） */
  append(text: string): this {
    if (text) this._appends.push(text);
    return this;
  }

  /** 获取当前已组装的文本（用于自引用检查，如"【不知道】"去重） */
  snapshot(): string {
    return [...this._prepends, this._body, ...this._appends]
      .filter(Boolean)
      .join('\n\n');
  }

  /** 检查已组装文本是否包含指定标记 */
  contains(marker: string): boolean {
    return this.snapshot().indexOf(marker) >= 0;
  }

  // ── 语义方法（16 个注入点，封装内部调用 prepend/append/setBody） ──

  /** #1: 基础文本（实体上下文 + 知识库文本） */
  withBaseText(entityCtx: string, kbText: string): this {
    this._body = entityCtx ? (entityCtx + '\n\n' + (kbText || '')) : (kbText || '');
    return this;
  }

  /** #2-#4: PFC 统一输出（assembledSystemPrompt + guardMessage + assembledContext） */
  withPFCUnified(parts: string[]): this {
    for (const p of parts) { if (p) this.prepend(p); }
    return this;
  }

  /** #5: PFC violations */
  withPFCViolations(violations: string[]): this {
    if (violations?.length) this.prepend(violations.join('\n'));
    return this;
  }

  /** #6: 事实回忆查询守卫 */
  withFactualRecallGuard(guard: string): this {
    if (guard) this.prepend(guard);
    return this;
  }

  /** #7: 角色路由注入（appended） */
  withRoleHint(hint: string): this {
    if (hint) this.append('【当前角色】' + hint);
    return this;
  }

  /** #8: 亲密度过滤器（prepended） */
  withIntimacyFilter(filter: string): this {
    if (filter) this.prepend(filter);
    return this;
  }

  /** #9: 知识库补充（appended） */
  withKBExtra(text: string): this {
    if (text) this.append(text);
    return this;
  }

  /** #10: "不知道"守卫（prepended，含自引用去重） */
  withDontKnow(): this {
    if (!this.contains('【不知道】')) {
      this.prepend('【不知道】这个问题我确实不知道答案。我不想编造，所以诚实地告诉你我不清楚。');
    }
    return this;
  }

  /** #11: 过往记忆背景（prepended，含自引用去重） */
  withMemoryBackground(memoryText: string): this {
    if (memoryText && !this.contains('【相关记忆】')) {
      const historyLink = '【情感背景·过往记忆】' + memoryText +
        '\n（以上是你以前的记忆片段。你**现在不在那些场景里**。如果当前话题提到了记忆中的人或事，可以用"我记得以前…"的方式轻轻提起。但**绝对不要从记忆里的场景开始说话**——你是正在和对方聊天的活人，不是在重演过去的场景。）';
      this.prepend(historyLink);
    }
    return this;
  }

  /** #12: 家族约束 + #12.5: 外观规则 */
  withFamilyConstraint(constraint: string): this {
    if (constraint) {
      this.prepend(constraint);
      this.append('【强制】外貌特征（身高/脸型/眼镜/发型等）按档案写明的说；档案里没写的，就说档案里没写。');
    }
    return this;
  }

  /** #13: 主人镜像（prepended） */
  withAboutYou(text: string): this {
    if (text) this.prepend(text);
    return this;
  }

  /** #14: M6 自我模型块（prepended） */
  withM6SelfModel(blocks: string[]): this {
    if (blocks?.length) this.prepend(blocks.join('\n'));
    return this;
  }

  /** #15: 追问上下文（prepended） */
  withFollowUp(text: string): this {
    if (text) this.prepend(text);
    return this;
  }

  /** #16: 引擎上下文（prepended） */
  withEngineContext(block: string): this {
    if (block) this.prepend(block);
    return this;
  }

  /**
   * #17: FG 实体人物参考档案（appended，正常模式）
   * 从 FamilyGraph.getPersonProfile 提取基本信息，构建"关于XX"参考文本。
   * 格式 ≠ identity（不含"你是XX本人"），仅作 LLM 的参考信息。
   */
  withEntityProfiles(fg: any, entityNames: string[]): this {
    if (!fg || !entityNames?.length) return this;
    const profiles: string[] = [];
    for (const name of entityNames) {
      try {
        const prof = fg.getPersonProfile(name);
        if (!prof) continue;
        const lines: string[] = [];
        if (prof.relation_to_user) lines.push(`关系: ${prof.relation_to_user}`);
        // 性格行：dossier.selfProfile.traits（与会晤模式 EntityContextBuilder「### 性格」同源，业主 2026-10-23 增补）
        const _traits = (prof as any)?.dossier?.selfProfile?.traits;
        if (Array.isArray(_traits) && _traits.length > 0) lines.push(`性格: ${_traits.slice(0, 4).join('、')}`);
        // 🔴 修复: 原 `(prof as any).basicInfo?.birthYear` 读顶层 basicInfo，但 getPersonProfile
        //    返回的是 node.properties 展开，birthYear 实际在 dossier.basicInfo —— 该年龄注入对所有
        //    用 dossier 的节点永不生效。改用归一化读取器 getPersonBio（dossier 优先+顶层兜底）。
        const bio = fg.getPersonBio?.(name);
        if (bio?.birthYear != null) lines.push(`${bio.birthYear}年生`);
        if (bio?.age != null) lines.push(`${bio.age}岁`);
        // 🆕 V10.9: 同步感知 edges warmth（与会晤模式 EntityContextBuilder 一致）
        try {
          const _uuid = fg.getUUIDByName?.(name);
          if (_uuid) {
            const _entity = fg.getEntityByUUID?.(_uuid);
            if (_entity) {
              const nodeCategory = (_entity as any)?.category || '';
              const warmEdges = fg.query?.(
                "SELECT properties FROM edges WHERE (source_id = ? OR target_id = ?) AND properties LIKE '%_relation_warmth%' LIMIT 5",
                [(_entity as any).id, (_entity as any).id]
              );
              for (const we of (warmEdges || []) as any[]) {
                const wp = JSON.parse(we.properties || '{}');
                if (wp._relation_warmth === 'intimate' || wp._relation_warmth === 'soulmate') {
                  lines.push('互动亲密度: 亲密（热力追踪已确认）');
                  if (nodeCategory === 'X') lines.push('关系分类: 情人');
                  break;
                }
              }
            }
          }
        } catch { /* warmth 查询失败不影响 */ }
        if (lines.length > 0) profiles.push(`【关于${name}】${lines.join('，')}`);
      } catch { /* 单条失败不影响其他 */ }
    }
    if (profiles.length > 0) this.append(profiles.join('\n'));
    return this;
  }

  /**
   * 按固定顺序装配最终知识文本。
   * 🚨 prepends → body → appends，同优先级内按调用先后顺序。
   */
  build(): string {
    return [...this._prepends, this._body, ...this._appends]
      .filter(Boolean)
      .join('\n\n');
  }
}
