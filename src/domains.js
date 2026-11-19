'use strict';

// 每个领域给出三套关键词：YouTube 用长尾词，X 用简短垂类词，Twitch 用直播垂类词。
// 关键词会在每次运行时轮换，避免每次都抓到同一批频道。
module.exports = [
  {
    id: 'news',
    name: '新闻 / 时政',
    queries: {
      youtube: [
        // 2026-11-01 按实测产出排序：每个词都跑过 1–2 页，括号里是当次
        // 「5k–20k 且未见过」的候选数。越靠前越容易出小号。
        // 全球议题
        'election analysis', // 7
        'protest movement analysis', // 5
        'diplomacy podcast', // 3
        'nuclear deterrence analysis', // 2
        'military strategy analysis', // 2
        'hybrid warfare analysis', // 2
        'energy geopolitics', // 1
        'sanctions analysis', // 1
        'humanitarian crisis analysis', // 1
        'foreign policy podcast', // 1
        'conflict analysis', // 1
        'information warfare analysis', // 1
        'maritime security analysis', // 1
        'defense policy analysis', // 1
        'baltic security', // 1
        // 拉美（地区细分实测产出最高）
        'bolivia politics', // 8
        'peru politics', // 6
        'chile politics', // 5
        'ecuador politics', // 4
        'colombia conflict analysis', // 4
        'brazil politics', // 1
        'argentina politics', // 1
        'mexico politics', // 1
        'venezuela politics', // 1
        'latin america politics',
        // 亚洲
        'taiwan politics', // 7
        'philippines politics', // 5
        'sri lanka politics', // 4
        'indonesia politics', // 4
        'vietnam politics', // 3
        'korean peninsula analysis', // 3
        'japan politics', // 3
        'thailand politics', // 2
        'central asia geopolitics', // 2
        'caucasus geopolitics', // 2
        'bangladesh politics', // 1
        'india geopolitics',
        'asia geopolitics',
        'south china sea analysis',
        'afghanistan geopolitics',
        // 中东
        'israel palestine analysis', // 6
        'iraq politics', // 5
        'lebanon politics', // 5
        'turkey politics', // 4
        'syria conflict analysis', // 3
        'iran politics', // 1
        'yemen war analysis', // 1
        'saudi arabia politics', // 1
        'middle east politics',
        'Middle East analysis',
        // 欧洲 / 俄罗斯
        'poland politics', // 5
        'romania politics', // 3
        'hungary politics', // 3
        'russia politics', // 3
        'moldova politics', // 2
        'ukraine war analysis',
        'balkan politics',
        'european union politics',
        // 非洲
        'horn of africa analysis', // 4
        'kenya politics', // 3
        'south africa politics', // 3
        'sudan war analysis', // 2
        'ghana politics', // 2
        'nigeria politics', // 1
        'ethiopia politics', // 1
        'africa geopolitics',
        // 兜底：通用词（实测区间内产出低，排在最后，轮到才搜）
        'OSINT',
        'military analysis',
        'news reporter vlog',
        'geopolitics podcast',
        'world affairs analysis'
      ],
      x: [
        'geopolitical analyst', 'political commentator', 'foreign policy analyst',
        'conflict reporter', 'war correspondent', 'independent journalist', 'news analyst',
        'africa geopolitics', 'asia geopolitics', 'middle east politics', 'european politics',
        'latin america politics', 'defense analyst', 'OSINT analyst', 'election analyst'
      ],
      twitch: ['news', 'politics', 'geopolitics', 'world news', 'middle east']
    }
  },
  {
    id: 'woodworking',
    name: '木工 / 手工',
    queries: {
      youtube: ['hand tool woodworking', 'woodworking handmade', 'wood carving beginner', 'small workshop woodworking'],
      x: ['woodworker hand tools', 'woodworking handmade'],
      twitch: ['woodworking', 'woodcarving']
    }
  },
  {
    id: 'restoration',
    name: '修复 / 翻新',
    queries: {
      youtube: ['vintage tool restoration', 'antique restoration', 'rusty tools restoration', 'old furniture restoration'],
      x: ['tool restoration', 'antique restoration'],
      twitch: ['restoration', 'restoring']
    }
  },
  {
    id: 'cooking',
    name: '美食 / 烹饪',
    queries: {
      youtube: [
        'village cooking',
        'home cooking recipe',
        'italian home cooking',
        'mexican home cooking',
        'indian home cooking',
        'thai street food',
        'japanese home cooking',
        'chinese home cooking',
        'korean home cooking',
        'turkish home cooking',
        'greek home cooking',
        'vietnamese home cooking',
        'street food cooking',
        'traditional food cooking'
      ],
      x: ['home cooking recipe', 'street food cook', 'italian cooking', 'mexican cooking', 'indian cooking', 'asian cooking'],
      twitch: ['cooking', 'food', 'home cooking', 'recipes']
    }
  },
  {
    id: 'baking',
    name: '烘焙 / 面包',
    queries: {
      youtube: ['sourdough baking', 'home bakery bread', 'artisan bread baking', 'beginner sourdough'],
      x: ['sourdough baker', 'home baking bread'],
      twitch: ['baking', 'sourdough']
    }
  },
  {
    id: 'photography',
    name: '摄影 / 胶片',
    queries: {
      youtube: ['film photography darkroom', 'analog photography', 'medium format film', 'street photography film'],
      x: ['film photographer', 'analog photography'],
      twitch: ['photography', 'film photography']
    }
  },
  {
    id: 'pottery',
    name: '陶艺 / 陶瓷',
    queries: {
      youtube: ['pottery wheel beginner', 'ceramics handmade', 'pottery studio vlog', 'hand built ceramics'],
      x: ['pottery ceramics artist', 'ceramic artist'],
      twitch: ['pottery', 'ceramics']
    }
  },
  {
    id: 'painting',
    name: '绘画 / 插画',
    queries: {
      youtube: ['oil painting landscape', 'watercolor painting tutorial', 'gouache illustration', 'digital illustration process'],
      x: ['oil painter', 'watercolor artist'],
      twitch: ['painting', 'illustration']
    }
  },
  {
    id: 'indie-game',
    name: '独立游戏开发',
    queries: {
      youtube: ['indie game devlog', 'solo game developer', 'godot devlog', 'unity indie game'],
      x: ['indie game devlog', 'solo game dev'],
      twitch: ['game development', 'indie dev']
    }
  },
  {
    id: 'retro-gaming',
    name: '复古游戏',
    queries: {
      youtube: ['retro game collecting', 'retro gaming', 'game collecting', 'retro console repair'],
      x: ['retro game collector', 'retro gaming'],
      twitch: ['retro games', 'retro gaming']
    }
  },
  {
    id: 'anime',
    name: '动画 / 漫画',
    queries: {
      youtube: ['anime retrospective', 'anime analysis', 'manga review', 'anime video essay'],
      x: ['anime review', 'manga reviewer'],
      twitch: ['anime', 'manga']
    }
  },
  {
    id: 'music',
    name: '音乐 / 乐器',
    queries: {
      youtube: ['fingerstyle guitar cover', 'bedroom music producer', 'piano cover', 'music production tutorial'],
      x: ['fingerstyle guitarist', 'music producer bedroom'],
      twitch: ['music production', 'guitar']
    }
  },
  {
    id: 'language',
    name: '语言学习',
    queries: {
      youtube: ['comprehensible input language learning', 'learn language through stories', 'polyglot language learning', 'beginner language lesson'],
      x: ['language learner polyglot', 'comprehensible input'],
      twitch: ['language learning', 'polyglot']
    }
  },
  {
    id: 'travel',
    name: '旅行 / 生活',
    queries: {
      youtube: ['solo female travel vlog', 'slow travel vlog', 'village life vlog', 'van life travel'],
      x: ['solo travel blogger', 'slow travel'],
      twitch: ['travel', 'irl travel']
    }
  },
  {
    id: 'outdoor',
    name: '户外 / 露营',
    queries: {
      youtube: ['solo bushcraft camping', 'wild camping', 'hiking camping', 'survival camping'],
      x: ['bushcraft camping', 'wild camping'],
      twitch: ['camping', 'outdoors']
    }
  },
  {
    id: 'fitness',
    name: '健身 / 运动',
    queries: {
      youtube: ['calisthenics beginner', 'running training', 'home workout', 'cycling training'],
      x: ['calisthenics coach', 'running coach'],
      twitch: ['fitness', 'workout']
    }
  },
  {
    id: 'tech',
    name: '科技 / 数码',
    queries: {
      youtube: ['mechanical keyboard build', 'home lab selfhosted', 'retro computer', 'arduino project'],
      x: ['mechanical keyboard', 'homelab selfhosted'],
      twitch: ['mechanical keyboards', 'homelab']
    }
  },
  {
    id: 'history',
    name: '历史 / 人文',
    queries: {
      youtube: ['forgotten history documentary', 'history documentary', 'philosophy lecture', 'archaeology documentary'],
      x: ['history documentary', 'history writer'],
      twitch: ['history', 'philosophy']
    }
  },
  {
    id: 'chess',
    name: '棋类 / 策略',
    queries: {
      youtube: ['chess endgame lesson', 'chess improvement', 'go board game', 'chess tactics'],
      x: ['chess coach', 'chess player'],
      twitch: ['chess', 'go game']
    }
  },
  {
    id: 'fiber',
    name: '编织 / 缝纫',
    queries: {
      youtube: ['beginner knitting', 'crochet tutorial', 'sewing vintage', 'hand embroidery'],
      x: ['knitter crochet', 'sewing handmade'],
      twitch: ['knitting', 'crochet']
    }
  },
  {
    id: 'miniatures',
    name: '模型 / 涂装',
    queries: {
      youtube: ['miniature painting warhammer', 'gunpla build', 'diorama build', 'model kit painting'],
      x: ['miniature painter', 'gunpla builder'],
      twitch: ['miniature painting', 'gunpla']
    }
  },
  {
    id: 'pets',
    name: '宠物 / 动物',
    queries: {
      youtube: ['pet vlog', 'aquarium setup', 'dog training', 'cat daily life'],
      x: ['pet vlogger', 'aquarium keeper'],
      twitch: ['pets', 'aquarium']
    }
  },
  {
    id: 'auto',
    name: '汽车 / 摩托',
    queries: {
      youtube: ['motorcycle camping', 'car restoration', 'motorcycle touring', 'garage build'],
      x: ['motorcycle rider', 'car restoration'],
      twitch: ['motorcycle', 'car restoration']
    }
  },
  {
    id: 'gardening',
    name: '园艺 / 种植',
    queries: {
      youtube: ['garden tour', 'permaculture garden', 'growing vegetables', 'balcony gardening'],
      x: ['gardener permaculture', 'grow your own'],
      twitch: ['gardening', 'plants']
    }
  },
  {
    id: 'diy',
    name: 'DIY / 手作',
    queries: {
      youtube: ['diy handmade', 'craft process', 'bookbinding', 'leather craft'],
      x: ['diy maker', 'handmade craft'],
      twitch: ['diy', 'crafts']
    }
  }
];
