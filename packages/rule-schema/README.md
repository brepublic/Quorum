# `@quorum/rule-schema`

Quorum 规则包 v1 的无服务器校验器、JSON Schema 和内置 fixture。校验器不执行 JavaScript、SQL、正则表达式、网络请求或动态模块。

```ts
import {validateRulePackage} from '@quorum/rule-schema';

const result = validateRulePackage(JSON.parse(text));
if (!result.ok) console.error(result.issues);
```

`fixtures/quorum-default.v1.json` 冻结现有产品中已经存在的默认行为；`fixtures/beijing-academic.v1.json` 只表达目标规格已经确认的北京包差异。两者当前都不会被 Firebase 前端自动加载。
