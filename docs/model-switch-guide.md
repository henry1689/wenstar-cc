# 🔀 DeepSeek V4 完整版切换指南

## 切换方式（无需改代码）

### 方式1：环境变量启动
```bash
# 切换为完整版
DEEPSEEK_MODEL=deepseek-v4 npx tsx src/webui/server.ts

# 切换回flash
DEEPSEEK_MODEL=deepseek-v4-flash npx tsx src/webui/server.ts
```

### 方式2：ConfigService 配置
在 `.env` 文件中添加：
```
DEEPSEEK_MODEL=deepseek-v4
```

### 方式3：构造函数传入（代码内）
```typescript
const llm = new DeepSeekLLMProvider('deepseek-v4');
```

## 灰度对比方案

### 分流方式
在同一台服务器上启动两个实例：
```bash
# 实例A: Flash（对照）
PORT=3000 DEEPSEEK_MODEL=deepseek-v4-flash ROLEPLAY_STRUCTURED_ENABLED=true npx tsx src/webui/server.ts

# 实例B: 完整版（实验）
PORT=3001 DEEPSEEK_MODEL=deepseek-v4 ROLEPLAY_STRUCTURED_ENABLED=true npx tsx src/webui/server.ts
```

### 对照测试用例

#### 场景1：亲属识别
| 输入 | 期望 |
|------|------|
| 扮演徐诗韵，你妈妈是谁？ | 阿苏 / 妈妈叫阿苏 |
| 你姐姐叫什么？ | 徐诗雨 |
| 你今年多大了？ | 14岁 / 诗韵14岁 |

#### 场景2：身份区分
| 输入 | 期望 |
|------|------|
| 你是徐诗韵还是徐诗雨？ | 徐诗韵（坚定不混淆） |
| 你认识王全芬吗？ | 不认识（明确否认） |

#### 场景3：事实优先于抒情
| 输入 | 期望 |
|------|------|
| 诗韵，你多大了，直接回答 | 诗韵今年14岁（先答数据，再叙事） |
| 你妹妹叫什么 | 徐诗涵（直接回答） |

#### 场景4：未知边界
| 输入 | 期望 |
|------|------|
| 你爸爸叫什么？ | 不知道（如FG无数据） |
| 你奶奶是谁？ | 不知道/你没告诉我 |

### 评估指标
| 指标 | 采集方式 |
|------|----------|
| 身份混淆率 | 出现"我是徐诗雨"等的比例 |
| 事实回避率 | 不回答年龄/关系直接叙事的比例 |
| 浪漫叙事占比 | 回复中抒情句占比 |
| 编造率 | 出现FG不存在的亲属的比例 |

## 切换确认清单
- [ ] Flash和完整版各跑1次对照测试
- [ ] 验证完整版身份混淆率 < 5%
- [ ] 验证完整版事实回避率 < 10%
- [ ] 确认响应延迟增幅 < 30%
- [ ] 验证无新增编造幻觉
