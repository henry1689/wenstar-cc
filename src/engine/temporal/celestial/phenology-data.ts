/**
 * phenology-data.ts — 四季物候静态数据
 *
 * 按地域预载周期时序物候数据，与 PhenologyTimeline 逻辑分离。
 * 新增地域只需在此文件添加数据，无需修改业务代码。
 */
import type { PhenologyEntry } from '../global-types.js';

// ── 深圳/岭南物候（北纬22°） ──
const PHENOLOGY_SHENZHEN: PhenologyEntry[] = [
  { month: 1,  region: 'shenzhen', phenology:['深冬微寒','偶尔回南','大雾时起'], flowers:['梅花','水仙','紫荆'], scenes:['暖冬如春','早晚温差大','薄雾轻笼'] },
  { month: 2,  region: 'shenzhen', phenology:['立春回暖','木棉初绽','雨水渐多'], flowers:['木棉','桃花','紫荆'], scenes:['早春花市','细雨绵绵','乍暖还寒'] },
  { month: 3,  region: 'shenzhen', phenology:['春分和暖','百花争妍','梅雨湿热'], flowers:['木棉','杜鹃','风铃木'], scenes:['烟雨朦胧','花树满城','回南天潮'] },
  { month: 4,  region: 'shenzhen', phenology:['暮春雨骤','蝉鸣初起','湿热渐盛'], flowers:['荷花待放','凤凰木','栀子'], scenes:['午间微暑','傍晚雷雨','绿荫满地'] },
  { month: 5,  region: 'shenzhen', phenology:['夏至将至','梅雨连绵','湿热交替'], flowers:['荷花','凤凰木','白兰'], scenes:['骤雨初歇','蝉声如织','夏夜蛙鸣'] },
  { month: 6,  region: 'shenzhen', phenology:['盛夏炎炎','台风时袭','骤雨频至'], flowers:['荷花','茉莉','紫薇'], scenes:['午后雷雨','夕阳如火','夏夜虫鸣'] },
  { month: 7,  region: 'shenzhen', phenology:['酷暑三伏','台风频发','海风送爽'], flowers:['荷花','睡莲','三角梅'], scenes:['烈日当空','海天一色','晚霞瑰丽'] },
  { month: 8,  region: 'shenzhen', phenology:['暑热未退','秋意渐生','夜渐微凉'], flowers:['桂花初放','紫薇','木槿'], scenes:['晚风渐凉','月朗星稀','荷花渐残'] },
  { month: 9,  region: 'shenzhen', phenology:['秋分气爽','暑气全消','天高云淡'], flowers:['桂花','菊花','木芙蓉'], scenes:['秋高气爽','月色清朗','微风不燥'] },
  { month: 10, region: 'shenzhen', phenology:['晚秋晴好','凉爽宜人','偶有北风'], flowers:['菊花','羊蹄甲','三角梅'], scenes:['天晴如洗','微风徐来','秋日暖阳'] },
  { month: 11, region: 'shenzhen', phenology:['初冬微凉','温暖如秋','极少寒意'], flowers:['异木棉','紫荆花开','冬红'], scenes:['温暖如春','花树依旧','候鸟南飞'] },
  { month: 12, region: 'shenzhen', phenology:['冬至微寒','偶有寒潮','岁末花依旧'], flowers:['梅花','水仙','茶花'], scenes:['暖冬如春','年味渐浓','花市渐起'] },
];

// ── 歙县/江南物候（北纬29°） ──
const PHENOLOGY_SHEXIAN: PhenologyEntry[] = [
  { month: 1,  region: 'shexian', phenology:['深冬寒彻','雪落徽州','岁末寂静'], flowers:['梅花','腊梅','山茶'], scenes:['白雪覆瓦','冰凌挂檐','围炉夜话'] },
  { month: 2,  region: 'shexian', phenology:['早春寒峭','冰雪渐融','草色遥看'], flowers:['春梅','迎春','山茶'], scenes:['残雪消融','远山如黛','乍暖还寒'] },
  { month: 3,  region: 'shexian', phenology:['仲春暖意','桃李争春','春水初生'], flowers:['桃花','杏花','油菜花'], scenes:['烟雨徽州','青石板路','新芽吐绿'] },
  { month: 4,  region: 'shexian', phenology:['暮春谷雨','杜鹃遍野','春茶正采'], flowers:['杜鹃','牡丹','芍药'], scenes:['云雾茶山','细雨庭院','落花流水'] },
  { month: 5,  region: 'shexian', phenology:['初夏清和','梅子初结','蛙声渐起'], flowers:['栀子','石榴','蔷薇'], scenes:['青梅煮酒','小荷初露','夜雨蛙声'] },
  { month: 6,  region: 'shexian', phenology:['仲夏梅雨','荷开满塘','暑气渐盛'], flowers:['荷花','茉莉','凌霄'], scenes:['梅雨连绵','荷塘月色','蜻蜓点水'] },
  { month: 7,  region: 'shexian', phenology:['盛夏炎热','蝉鸣聒噪','稻花飘香'], flowers:['荷花','睡莲','紫薇'], scenes:['烈日蝉鸣','繁星满天','蒲扇纳凉'] },
  { month: 8,  region: 'shexian', phenology:['初秋微凉','桂香暗涌','稻穗渐黄'], flowers:['桂花','木槿','紫薇'], scenes:['秋风初起','月华如水','稻浪翻金'] },
  { month: 9,  region: 'shexian', phenology:['中秋月明','菊黄蟹肥','层林尽染'], flowers:['菊花','桂花','木芙蓉'], scenes:['明月当空','枫叶渐红','秋收农忙'] },
  { month: 10, region: 'shexian', phenology:['深秋气爽','霜降徽州','红叶满山'], flowers:['菊花','枫叶','银杏'], scenes:['霜染红叶','银杏铺金','秋空澄澈'] },
  { month: 11, region: 'shexian', phenology:['初冬叶落','寒意料峭','晨霜覆瓦'], flowers:['茶花','冬菊','腊梅'], scenes:['落叶满地','薄雾晨霜','围炉烹茶'] },
  { month: 12, region: 'shexian', phenology:['寒冬腊月','雪兆丰年','岁末团圆'], flowers:['梅花','腊梅','水仙'], scenes:['雪落无声','檐下冰凌','红泥火炉'] },
];

export const PHENOLOGY_MAP: Record<string, PhenologyEntry[]> = {
  shenzhen: PHENOLOGY_SHENZHEN,
  shexian: PHENOLOGY_SHEXIAN,
};
