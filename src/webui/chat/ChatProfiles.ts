/**
 * ChatProfiles — 人物档案提取管线
 * chat.ts L454-691 原样拆出
 */
import type { ChatContext } from '../chat.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function extractPersonProfiles(
  ctx: ChatContext,
  message: string,
  dna: any,
  _currentRoleplay: string | null,
): void {
  if (!ctx.m4) return;
      try {
        if (ctx.m4) {
          console.log('[PersonProfile] getFamilyGraph...');
          const _fgX = ctx.m4.getFamilyGraph();
          console.log('[PersonProfile] fg=' + (!!_fgX));
          if (_fgX) {
            // 检测是否为人物描述（含外貌/身体/性格/习惯等特征词）
            const _descWords = /长得|长相|外貌|样子|身高|身材|个子|皮肤|脸|眼睛|鼻子|嘴巴|头发|发型|漂亮|好看|帅|美|可爱|清秀|性感|苗条|丰满|矮|瘦|胖|圆|胸|奶子|屁股|腿|腰|肩|手|性格|个性|开朗|幽默|内向|外向|温柔|活泼|安静|习惯|喜欢|爱好|兴趣|说话|声音|嗓音|穿着|打扮|戴|气质|文气|纯欲|知性|精致|斯文/;
            console.log('[PersonProfile] descWords测试=' + _descWords.test(message));
            // P0-1: 仅使用M1标准化实体，禁止任何手写人名正则
            if (_descWords.test(message)) {
              const _pNames: string[] = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1).map((g: any) => g.name);
              if (_pNames.length === 0) {
                console.log('[PersonProfile] M1未提取到人名，跳过（不手写正则兜底）');
              }
              for (const _n of _pNames) {
                const _prof = _fgX.getPersonProfile(_n);
                if (!_prof) {
                  console.error('[PersonProfile] ERROR: 节点 ' + _n + ' 不存在于FamilyGraph，跳过');
                  continue;
                }
                const _updates: any = {};
                const _sents = message.split(/[，,。.！!？?；;\n]/);
                let _desc = _prof.description || '';
                let _app = _prof.appearance || '';
                let _body = _prof.body_features || '';
                let _inDesc = false;
                for (const _s of _sents) {
                  const _ts = _s.trim();
                  if (!_ts) continue;
                  if (_ts.includes(_n)) { _inDesc = true; }
                  else if (/^(她|他)/.test(_ts)) { _inDesc = true; }
                  if (!_inDesc) continue;
                  const _clean = _ts.replace(_n, '').replace(/^[她他的]/, '').trim();
                  if (!_clean) continue;
                  // 分类矫正：外貌/身体/其他
                  if (/长得|长相|外貌|样子|个子|皮肤|脸|眼睛|鼻子|嘴巴|头发|发型|漂亮|好看|帅|美|清秀|可爱|圆脸|瓜子脸|酒窝|马尾|刘海|白|黑|高|矮|瘦|胖/.test(_ts)) {
                    const _item = _clean.replace(/身高(\d)\.(\d+)/, '身高$1.$2'); // 数字完整性
                    if (!_app.includes(_item)) _app += (_app ? '，' : '') + _item;
                  } else if (/身材|胸|奶子|屁股|臀|腿|腰|肩|手|苗条|丰满|性感|翘|细|粗/.test(_ts)) {
                    if (!_body.includes(_clean)) _body += (_body ? '，' : '') + _clean;
                  } else {
                    if (!_desc.includes(_clean)) _desc += (_desc ? '，' : '') + _clean;
                  }
                }
                // P1-4: 冲突检测——新旧描述矛盾时标记
                if (_prof.appearance && _app && _app !== _prof.appearance) {
                  const _oldParts: Set<string> = new Set(_prof.appearance.split(/[，,]/).map((s: string) => s.trim()).filter(isNonEmptyString));
                  const _newParts = _app.split(/[，,]/).map((s: string) => s.trim()).filter(isNonEmptyString);
                  for (const _np of _newParts) {
                    // 检测冲突：新描述中说"高"但旧描述说"矮"或反之
                    if (/高/.test(_np) && [..._oldParts].some((o: string) => /矮/.test(o))) {
                      console.warn('[PersonProfile] CONFLICT: ' + _n + ' 身高冲突（高 vs 矮）');
                    }
                    if (/矮/.test(_np) && [..._oldParts].some((o: string) => /高/.test(o))) {
                      console.warn('[PersonProfile] CONFLICT: ' + _n + ' 身高冲突（矮 vs 高）');
                    }
                    if (/胖/.test(_np) && [..._oldParts].some((o: string) => /瘦/.test(o))) {
                      console.warn('[PersonProfile] CONFLICT: ' + _n + ' 体型冲突（胖 vs 瘦）');
                    }
                    if (/瘦/.test(_np) && [..._oldParts].some((o: string) => /胖/.test(o))) {
                      console.warn('[PersonProfile] CONFLICT: ' + _n + ' 体型冲突（瘦 vs 胖）');
                    }
                  }
                }
                if (_app) _updates.appearance = _app;
                if (_body) _updates.body_features = _body;
                if (_desc) _updates.description = _desc;
                if (Object.keys(_updates).length > 0) {
                  // 📜 写操作用真实FG（绕过角色扮演分支），读操作用_fgX保留角色视角
                  const _realFg = ctx.m4?.getRealFamilyGraph?.() || _fgX;
                  _realFg.updatePersonProfile(_n, _updates as any, { countMention: false });
                  console.log('[PersonProfile] 已更新 ' + _n + ' 的档案');
                }
                // P1-2: 外貌特征提取为附属实体（支持反向检索）
                if (_app || _body) {
                  const _allFeatures = (_app + '，' + _body).split(/[，,]/).filter(Boolean);
                  const _featureKey = /个子|高|矮|瘦|胖|脸|眼睛|鼻|嘴|牙|头发|发|眼镜|皮肤|白|黑|圆|瓜子|酒窝|马尾|刘海|眉|睫毛|胸|臀|腿|腰|肩|手|苗条|丰满|性感|翘|细|粗|长发|短发|卷发|直发/;
                  for (const _f of _allFeatures) {
                    const _trimmed = _f.trim();
                    if (_trimmed.length > 1 && _featureKey.test(_trimmed)) {
                      try {
                        const _sqlite = ctx.storage.getSQLite();
                        // 清洗特征名为标准格式
                        const _featName = _trimmed.replace(/^(很|比较|非常|有点)+/, '').substring(0, 20);
                        // 确保entities表存在
                        const _exist = _sqlite.queryAll("SELECT id FROM entities WHERE name = ? AND type = 'object'", [_featName]);
                        let _featId: number;
                        if (_exist.length > 0) {
                          _featId = (_exist[0] as any).id;
                        } else {
                          _sqlite.writeRaw("INSERT INTO entities (name, type) VALUES (?, 'object')", [_featName]);
                          const _newRows = _sqlite.queryAll("SELECT id FROM entities WHERE name = ? AND type = 'object'", [_featName]);
                          _featId = (_newRows[0] as any)?.id;
                        }
                        if (_featId) {
                          // 关联人物特征
                          const _personEntity = _sqlite.queryAll("SELECT id FROM entities WHERE name = ? AND type = 'person'", [_n]);
                          if (_personEntity.length > 0) {
                            _sqlite.writeRaw(
                              "INSERT OR IGNORE INTO entity_relations (entity_a_id, entity_b_id, relation, strength, updated_at) VALUES (?, ?, 'has_feature', 0.5, ?)",
                              [_personEntity[0].id, _featId, new Date().toISOString()]
                            );
                            // (FG-迁移) 同步写入 FamilyGraph 特征边（角色扮演时跳过）
                            if (!_currentRoleplay) try { ctx.m4?.getFamilyGraph()?.addFeatureEdge(_n, _featName, 'appearance').catch(() => {}); } catch (e) { console.warn(`[ChatProfiles] 操作失败`, (e as Error)?.message || e); }
                          }
                        }
                      } catch (e: any) { console.error('[chat] error:', e?.message); }
                    }
                  }
                  console.log('[PersonProfile] 已提取 ' + _n + ' 的外貌特征（反向检索可用）');
                }
              }
            }
          }
        }
      } catch (_ae) { console.warn('[PersonProfile] 失败:', (_ae as Error)?.message); }
  
      // P3: 答案提取 — 用户回答了玉瑶之前的问题，提取信息更新画像
      try {
        let personGenes = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我');
        // 如果当前消息没有显式人名但用了"他/她/这人"，从历史找最近被问的人
        if (personGenes.length === 0 && (/^他|^她|^那|^这/.test(message) || message.length < 15) && ctx.m4) {
          const graph = ctx.m4.getFamilyGraph();
          if (graph) {
            for (let i = ctx.conversationHistory.length - 1; i >= 0 && i > ctx.conversationHistory.length - 6; i--) {
              const turn = ctx.conversationHistory[i];
              if (turn.role === 'assistant' && turn.content) {
                // 用姓氏匹配找回复中提到的人名
                const SURNAMES_CHAR = '赵孙李周吴郑王冯陈褚蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹柏水窦章苏潘葛彭郎鲁韦马苗凤花方俞任袁柳鲍史费廉岑薛雷贺倪汤罗郝邬安乐于时傅卞齐康余元卜顾孟平和穆萧尹邵湛汪祁毛禹狄贝明臧计戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴荣翁荀於惠甄家封羿储靳邴糜松段富乌焦巴弓牧谷车侯宓蓬全郗班仰仲伊宫宁仇甘厉戎符刘景詹束龙叶幸司韶黎薄印宿白蒲从鄂索赖卓蔺屠蒙池乔阴苍双闻莘党翟谭劳逄姬申扶冉宰郦雍郤濮牛寿通扈燕郏浦尚农别庄柴阎充慕茹习宦艾鱼容向古易慎戈廖庾衡步耿满弘匡寇广禄阙沃蔚越隆师巩厍聂晁敖融辛阚那简饶曾毋沙乜养鞠须丰巢关蒯相查荆红游竺逯盖桓公';
                const nameRegex = new RegExp('([' + SURNAMES_CHAR + '][一-龥]{1,2}|阿[一-龥]|小[一-龥])', 'g');
                const allMatches = turn.content.match(nameRegex);
                if (allMatches) {
                  for (const name of allMatches) {
                    const profile = graph.getPersonProfile(name);
                    if (profile) {
                      personGenes.push({ name, type: 'person' } as any);
                      break;
                    }
                  }
                  if (personGenes.length > 0) break;
                }
              }
            }
          }
        }
        if (personGenes.length > 0 && ctx.m4) {
          const graph = ctx.m4.getFamilyGraph();
          if (graph) {
            // 关系关键词提取
            const relMap: Record<string, string> = { '同事':'同事','同学':'同学','朋友':'朋友','室友':'室友','老板':'老板','上司':'上司','领导':'领导','客户':'客户','合伙人':'合伙人','邻居':'邻居','老师':'老师','医生':'医生','顾问':'顾问','下属':'下属' };
            // 职业关键词提取
            const occHints = [/做([^，。！？\s]{2,12})的/, /开([^，。！？\s]{2,12})店/, /干([^，。！？\s]{2,12})的/, /([^，。！？\s]{2,12}工程师)/, /([^，。！？\s]{2,12}老师)/, /([^，。！？\s]{2,12}医生)/];
            // 特征关键词
            const traitMap: Record<string, string[]> = { '开朗':['开朗','爱笑','大方'],'幽默':['幽默','搞笑','逗'],'热心':['热心','帮忙','帮了'],'温柔':['温柔','体贴','细心'],'能干':['能干','厉害','强'],'靠谱':['靠谱','可靠','放心'],'有趣':['有趣','好玩','有意思'],'老实':['老实','本分','踏实'] };
  
            for (const p of personGenes) {
              const profile = graph.getPersonProfile(p.name);
              if (!profile) continue;
  
              const updates: Record<string, any> = {};
  
              // 提取关系
              for (const [rel, val] of Object.entries(relMap)) {
                if (message.includes(rel)) { updates.relation_to_user = val; break; }
              }
  
              // 提取职业
              for (const re of occHints) {
                const m = message.match(re);
                if (m && m[1] && !/什么|哪|哪里|哪儿/.test(m[1])) { updates.occupation = m[1]; break; }
              }
  
              // 提取特征
              const foundTraits: string[] = [];
              for (const [trait, keywords] of Object.entries(traitMap)) {
                if (keywords.some(kw => message.includes(kw))) foundTraits.push(trait);
              }
              if (foundTraits.length > 0) {
                const existing = profile.traits || [];
                updates.traits = [...new Set([...existing, ...foundTraits])];
              }
  
              if (Object.keys(updates).length > 0) {
                const _realFg = ctx.m4?.getRealFamilyGraph?.() || graph;
                _realFg.updatePersonProfile(p.name, updates as any, { countMention: false });
                console.log('[Profile] 更新画像:', p.name, Object.keys(updates).join(','));
              }
            }
          }
        }
      } catch (err) {
        console.warn('[ProfileExtract] 答案提取失败:', (err as Error).message);
      }
}
