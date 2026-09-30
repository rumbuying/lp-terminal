/** Fables Robinhood Chain deployment verified from activePools at block 76165916.
 * Runtime hashes were read with eth_getCode; ABI capability was checked against
 * Sourcify matched source for every currently registered hook (2026-09-26,
 * re-verified 2026-09-30 — all pinned hooks, registry and lens unchanged).
 * A newly registered or changed hook must fail closed until reviewed. New
 * pools on reviewed hooks warn in the indexer but do not stop it; they stay
 * unreviewed here until this snapshot is refreshed by hand. */
export const FABLES_REGISTRY = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3' as const
export const FABLES_LENS = '0xE44c0BAb43BdD47e7Ab40236bC183dCc77A9ED6c' as const
export const FABLES_REGISTRY_CODE_HASH = '0x766fbad3b8b636c92f3bcba04abc3e83b4dd77e30ae81fe9ae1a89f19aaa151d' as const
export const FABLES_LENS_CODE_HASH = '0x2a283dae21827aaed7a80eb6b462c90b5c1a1ca30af276298fcbcd4922360bb4' as const

export const FABLES_HOOKS = {
  '0x66622f77b797d506e5376f7798b67ab288966080': { codeHash: '0xe23b7cfc414c8f3e7405696db74100672a43a707d7156fcf6c4b0ba1a126d36a', withdrawAndClaim: false },
  '0xa0e8fbff13e24af2b5e61a72800e08a161bde080': { codeHash: '0x336405ef8a51dd6b02b53eb46fccddc87bf15dbd0a16b3d86fccc3e0298eca73', withdrawAndClaim: false },
  '0x79576fbad6e83915630bbb5d5658483f05532080': { codeHash: '0x165ccaced1f37263fd1a36b051c43d1759bab3005c2f7083ab32ee2db3b217e3', withdrawAndClaim: false },
  '0x70a9a88402989226847ec122043ce5e7ff462080': { codeHash: '0x165ccaced1f37263fd1a36b051c43d1759bab3005c2f7083ab32ee2db3b217e3', withdrawAndClaim: false },
  '0x67d86050d22d574df046f3d90f722045f714e080': { codeHash: '0xa40a02521b3a20e56851d833baf5baf0ee258e954c0f4e3f96e1bd30c8681db3', withdrawAndClaim: false },
  '0x06a889870c8f83640d6816319f72e2aa579b6080': { codeHash: '0x0430617b26dfc5c3f6be1e1733304c6050c6b6ba9d0fb950b57070b5b2a96db4', withdrawAndClaim: false },
  '0xb608a78761f179f7c56f15e7d13921b92f00a080': { codeHash: '0x514b632f9bb987403ca7a3fb35780b2c092726a437c1efbb4479fd612549d25b', withdrawAndClaim: false },
  '0xa4570c37590e45f0b06898123d4de16307a32080': { codeHash: '0x514b632f9bb987403ca7a3fb35780b2c092726a437c1efbb4479fd612549d25b', withdrawAndClaim: false },
  '0x8af95932ec4484fb10c641a4cbcf19a798cb2080': { codeHash: '0x514b632f9bb987403ca7a3fb35780b2c092726a437c1efbb4479fd612549d25b', withdrawAndClaim: false },
  '0x5eb87f69be00df39981622fd60a8de4b7837e080': { codeHash: '0x577978ad29223268205cb40a5215c46839f5c27a1218beac7d4a0f7cd0aaa341', withdrawAndClaim: true },
  '0x08e52564bad99e05a694b4809f397edca417a080': { codeHash: '0xbb52b2dc4a14fc6c3f90d0a268b51680d7adbdaa392b211bc524b6fd9368bb85', withdrawAndClaim: true },
  '0xca89f079af00f752bfd3c345358dc38d4d73e080': { codeHash: '0xf66d3f0d67c0781d5062346265ed0a0ef1826156a26b836b3786a452fc95b34f', withdrawAndClaim: true },
  '0x594e8e6281edf2d363a0293a50004cf868e7a080': { codeHash: '0x4ef97bd8b342b9a23f1d29fbca064fb385bb089a503e4fdb1018f7970dc9e08e', withdrawAndClaim: true },
} as const

export type FablesHook = keyof typeof FABLES_HOOKS
export const fablesHook = (address: string) => FABLES_HOOKS[address.toLowerCase() as FablesHook] ?? null

/** PoolIds observed in the reviewed registry snapshot. New rows require review:
 * until they land here the indexer only warns about them, and they are
 * invisible to positions, manual refs and auto-execution. */
export const FABLES_KNOWN_POOL_IDS = new Set<string>([
  '0x7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd',
  '0x8674c1c5544f3c9563565b5d4bd5916701d90b3559b072acf7cef5b4fc5b8dcd',
  '0x988f3b6ceec4795e0d6d28a054af87ffbcbdeee2566f72ae391da5f109bd485f',
  '0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147',
  '0xd5effce87036cd858146c0c15fa825c231a9de1843200ca108e431e431331e8e',
  '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551',
  '0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a',
  '0x118887805417a88865010dfe9ab3a516214e720aff2b01a19fcdb92b924c397f',
  '0x4ac4259eb99dce57268a856719d087fa1a53569b2fed6f330aabe32d9a4aa4f5',
  '0x6ef20273e821b24ca2b27861d700db239c5449f6446c91d13d9c2bc01c7b8bb9',
  '0x31608601d541e868706aa557558a4d4f99c57e6dd13bd3362edcf05d00a16212',
  '0x31f8624041c93e2abd0fb23540d259b069fa76c053eb7e3f5abc754d7194726b',
  '0xb59001413cb070e28433826f927b7265a0813213ba21f454d86896cee3cce674',
  '0x5619cb8420678b47997f20925eb01be8750c907d6226a0df5d7eafeff966346f',
  '0x16dce5f6a91bd93c2f5f05866dbb780afbe47d2776ea8dcdbb758efff57248a7',
  '0xb81d873dfb2bb1aaf08804053f8940fd06bb30a2b5a0fafcdbcc7325544452b9',
  '0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea',
  '0x8660c1c24d58fdad98d9008be534240e5d79ece4d4d4ef16f215af001779ec1f',
  '0xbb15d6b62c893a86912b5d4b14599f9cc72111e5898327dcadefa0352f20ae11',
  '0x01b71670a61dd9175a3d1e08d4e0af00ce71e76d230c92649f3ce9857f7d4abd',
  '0x422ed2d698601ea2114b103501e305ae7e3164f87079c72c626d2df832d74a0e',
  '0xe85f633a1374ee279140fa997b547d6a2ccd94fc5eae0e98f7d15ce0e3ddfa93',
  '0xf7e180365aed9c463022976c37c615f483bfbe57717b665deff31922c877c8b3',
  '0xd40585db9c332f3dcd82a77546c9670e38f82f06f18460eb3c4fca2adeda863e',
  '0x592e3fb7ea947506b36481025abc15baada8e1839a50fded46ecf08b3182fa96',
  '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485',
  '0x4e2a7c0057cec67170ee71641d23d0e835afb6f1deb6b4c6a182b4c16ec8f594',
  '0x8fb2273e40a44bd4b442bf7f24b953e46a7ecae7384038b266008ae44ebe62be',
  '0x4aaa4f57bec2b6e67dac42909c8c4f9a6ddaf02bb63f8dcbbafb35316731d2a7',
  '0xf50a897ae1b4dfdac5a8d573f0d0f59c75832b7832b7e631e1192d1e64019039',
  '0x286f707c75266f4633638e557c6ada1bd4c58c3d533badb8c440a851f0940aa2',
  '0x8e36bc9877b9383ae306dd937d40ab0e9df65811e7fdfb6bad25e7102bc398b2',
  '0x6948116f31d66206c10fc6aa6eff7e58842f2fb4dc32533f972a1cd50ed77e02',
  '0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6',
  '0xe1c3e133c917674bd51704e47c7dfe7f0d66375c89ceb30b083de95f9a1dc5ea',
  '0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92',
  '0x29bb26f93fe1bbbf81ee62671cc2a66fbf318f20e6b0757607a2fe3713651fdf',
  '0xa1f381b8938b5a9dfb601e692958bc5eff9898f4468ab5e398a52a0d53575093',
  // 2026-09-30 refresh: 19 pools registered since the 2026-09-26 snapshot,
  // all on already-pinned hooks with unchanged runtime code (verified
  // on-chain) and registry ids recomputed from their pool keys.
  '0x0bae6c92e5af1240e8728b77ff86139a5d90e6f63b14d67d606671b0fd9abaf5',
  '0x0f4d4d8a40ce635f1317f18b9fdf41fb5492bec9763abdacf3ea59a2c3bf5758',
  '0x3078bf0a7a6b5a2eb4bc367516854ae93a9aae334e0067f2a2be5cb616bfec6f',
  '0x3428910987af3506702305be9869f3320b55d7f280af90804bf376786f6082fe',
  '0x4030f646babe7643c33ee0b9a5123e04ee97a8820a26d0d9dec8b0265f31170d',
  '0x46c24538a851e105a217d2b9b23e2f7f1cb47fbc136572c92d023e36bebd98fe',
  '0x5e4c353496e4c82a406a38ca1eaad6d2d4cdb8d405d422faff84bcb6f548d97e',
  '0x6c330014af1c9e8fd0c6b5e3407439af7bce820c53c72cff168c1b92d9f96ca2',
  '0x76d4e09a330a2f1b110a7ffba2c52804c8d4b64615254590e06822575ee9097e',
  '0x7e42e835239ea7f2707b77b7672e4358aa2b799746274ab1254d8a576b5f56fb',
  '0x8138ea2894ce8f825d830569df6faf33e55344290954ce22432ca4f11913bacc',
  '0x9fc86429019dc022aa8981fc0bf2710a05fb21787e30b1f3b714d243e9fb26d9',
  '0xaf30b4c0110121efe3702cbead77d943d0765eb772fea5341d37b73364066ff9',
  '0xb4f01c156256c361e938e1391421d1297db290f9a055c1ad4a33dd42e6a76b5e',
  '0xbe1a90db81cf52603ea9059a6fde2e5fa893a8750647ff189ee7618c61b4c4f9',
  '0xcb69f1b3d627d84795f6ba157faa1051f6160919d7f3cd0e510ff6afcbe03961',
  '0xcf0bd6587434f9f6b6e7745230f137a4a0e3910e42b60448e151e09d9361394e',
  '0xd98f0f503d64cfe5e28db27054318c28cc7bf3d03b66932c41fb46e4ffba3107',
  '0xdc844c8cc27ad9a1d122c03adeadc8b3652d29008d88344823ad9d52555b926b',
])

/** An explicit deployment choice, restricted to the reviewed registry above. */
export function parseFablesAutoPoolIds(value: string | undefined): Set<string> {
  if (!value?.trim()) return new Set()
  const approved = new Set<string>()
  for (const raw of value.split(',')) {
    const poolId = raw.trim().toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(poolId) || !FABLES_KNOWN_POOL_IDS.has(poolId))
      throw new Error(`Fables auto pool is not in the reviewed registry: ${poolId}`)
    approved.add(poolId)
  }
  return approved
}

const buildAutoPools = (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
  .env?.VITE_FABLES_AUTO_POOL_IDS
const runtimeAutoPools = typeof process !== 'undefined' ? process.env.LP_FABLES_AUTO_POOL_IDS : undefined
/** Empty by default. Both web build and executor runtime must opt in separately. */
export const FABLES_AUTO_POOL_IDS = parseFablesAutoPoolIds(buildAutoPools ?? runtimeAutoPools)
