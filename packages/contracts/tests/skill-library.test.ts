import { describe, expect, it } from 'vitest';

import {
  coveredRoleTitles,
  lookupRoleRequirements,
  normalizeAlias,
  parseSkillRequirementLibrary,
  resolveSkillId,
  skillMetaFor,
} from '../src/skill-library.ts';

/** 最小可用库：两个技能、一个岗位。各用例在其上做定点破坏。 */
const LIB = {
  libraryVersion: 'curated-v1',
  source: 'CURATED',
  skills: [
    {
      skillId: 'sql',
      label: 'SQL',
      aliases: ['Postgres', 'PostgreSQL', 'MySQL'],
      category: 'HARD',
      remediationType: 'COURSE_SKILL',
    },
    {
      skillId: 'user-research',
      label: '用户研究',
      aliases: ['User Research', '用户访谈'],
      category: 'HARD',
      remediationType: 'EXPERIENCE_GAP',
    },
  ],
  roles: [
    {
      roleKey: 'data analyst',
      roleTitle: 'Data Analyst',
      requirements: [
        { skillId: 'sql', requiredLevel: 3, importance: 'MUST' },
        { skillId: 'user-research', requiredLevel: 1, importance: 'NICE' },
      ],
    },
  ],
};

/** 取拒收码；意外通过时返回哨兵值，让断言给出可读的失败信息。 */
const codeOf = (input: unknown): string => {
  const result = parseSkillRequirementLibrary(input);
  return result.ok ? 'UNEXPECTED_OK' : result.code;
};

const parsed = () => {
  const result = parseSkillRequirementLibrary(LIB);
  if (!result.ok) throw new Error(`fixture 应当合法，实际 ${result.code}`);
  return result.value;
};

describe('parseSkillRequirementLibrary · 形状', () => {
  it('接受合法库', () => {
    const result = parseSkillRequirementLibrary(LIB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toHaveLength(2);
      expect(result.value.roles[0]!.requirements).toHaveLength(2);
    }
  });

  it('多一个键整帧拒收', () => {
    expect(parseSkillRequirementLibrary({ ...LIB, note: 'x' })).toEqual({
      ok: false,
      code: 'SKILL_LIBRARY_MALFORMED',
    });
  });

  it('缺 libraryVersion 或 source 非法值拒收（版本要进缓存键，不可省）', () => {
    const { libraryVersion: _dropped, ...missing } = LIB;
    expect(parseSkillRequirementLibrary(missing).ok).toBe(false);
    expect(parseSkillRequirementLibrary({ ...LIB, source: 'GUESSED' }).ok).toBe(false);
  });

  it('requiredLevel 只收 0–4 序数，importance 只收闭集', () => {
    const badLevel = {
      ...LIB,
      roles: [{ ...LIB.roles[0], requirements: [{ skillId: 'sql', requiredLevel: 7, importance: 'MUST' }] }],
    };
    const badImportance = {
      ...LIB,
      roles: [{ ...LIB.roles[0], requirements: [{ skillId: 'sql', requiredLevel: 3, importance: 'REQUIRED' }] }],
    };
    expect(parseSkillRequirementLibrary(badLevel).ok).toBe(false);
    expect(parseSkillRequirementLibrary(badImportance).ok).toBe(false);
  });
});

// 人工维护的库最容易腐化的六种方式，每种一条专用错误码。
describe('parseSkillRequirementLibrary · 跨条目完整性（防腐层）', () => {
  it('重复 skillId → DUPLICATE_SKILL', () => {
    const bad = { ...LIB, skills: [...LIB.skills, { ...LIB.skills[0], label: 'SQL 又一条' }] };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_DUPLICATE_SKILL');
  });

  it('别名指向两个技能 → ALIAS_COLLISION（对齐会二义）', () => {
    const bad = {
      ...LIB,
      skills: [LIB.skills[0], { ...LIB.skills[1], aliases: ['Postgres'] }],
    };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_ALIAS_COLLISION');
  });

  it('一个技能的 label 撞上另一个技能的 alias → 同样按二义拒收', () => {
    const bad = {
      ...LIB,
      skills: [LIB.skills[0], { ...LIB.skills[1], aliases: ['sql'] }],
    };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_ALIAS_COLLISION');
  });

  it('重复 roleKey → DUPLICATE_ROLE', () => {
    const bad = { ...LIB, roles: [...LIB.roles, { ...LIB.roles[0], requirements: [] }] };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_DUPLICATE_ROLE');
  });

  it('roleKey 不是 roleTitle 的归一化结果 → ROLE_KEY_MISMATCH', () => {
    const bad = { ...LIB, roles: [{ ...LIB.roles[0], roleKey: 'Data-Analyst' }] };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_ROLE_KEY_MISMATCH');
  });

  // 最要命的一种：改词典时删了技能，岗位那边还引着。
  it('岗位引用词典里没有的 skillId → UNKNOWN_SKILL_REF（悬空引用）', () => {
    const bad = { ...LIB, skills: [LIB.skills[0]] };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_UNKNOWN_SKILL_REF');
  });

  it('同一岗位重复要求同一技能 → DUPLICATE_REQUIREMENT', () => {
    const bad = {
      ...LIB,
      roles: [
        {
          ...LIB.roles[0],
          requirements: [
            { skillId: 'sql', requiredLevel: 3, importance: 'MUST' },
            { skillId: 'sql', requiredLevel: 2, importance: 'NICE' },
          ],
        },
      ],
    };
    expect(codeOf(bad)).toBe('SKILL_LIBRARY_DUPLICATE_REQUIREMENT');
  });
});

describe('lookupRoleRequirements', () => {
  it('岗位名称大小写／空白不敏感', () => {
    expect(lookupRoleRequirements(parsed(), '  DATA   analyst ')).toHaveLength(2);
  });

  // 铁律：库不是万能表。未收录岗位必须落空，让上游标 UNKNOWN。
  it('未收录岗位返回 null —— 绝不编造要求', () => {
    expect(lookupRoleRequirements(parsed(), 'Quantum Chef')).toBeNull();
  });
});

describe('resolveSkillId · 自由文本对齐', () => {
  it('别名、label、id 都能对上，且大小写不敏感', () => {
    const lib = parsed();
    expect(resolveSkillId(lib, 'postgres')).toBe('sql');
    expect(resolveSkillId(lib, 'MySQL')).toBe('sql');
    expect(resolveSkillId(lib, 'SQL')).toBe('sql');
    expect(resolveSkillId(lib, '用户访谈')).toBe('user-research');
  });

  it('对不齐返回 null —— 不做模糊猜测', () => {
    expect(resolveSkillId(parsed(), '写得一手好诗')).toBeNull();
  });

  it('normalizeAlias 折叠大小写与多余空白', () => {
    expect(normalizeAlias('  User   RESEARCH ')).toBe('user research');
  });
});

describe('skillMetaFor / coveredRoleTitles', () => {
  it('给出 label／category／remediationType，供推荐动作决策', () => {
    expect(skillMetaFor(parsed(), 'user-research')).toEqual({
      label: '用户研究',
      category: 'HARD',
      remediationType: 'EXPERIENCE_GAP',
    });
  });

  it('未收录技能返回 null', () => {
    expect(skillMetaFor(parsed(), 'nope')).toBeNull();
  });

  it('可列出覆盖的岗位（运营盘点覆盖面）', () => {
    expect(coveredRoleTitles(parsed())).toEqual(['Data Analyst']);
  });
});
