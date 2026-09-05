// Random policy: pick a command type uniformly among the types currently legal, then a
// uniform command of that type. Type-uniform keeps startCombat reachable even when
// hundreds of `place` variants are legal.
import type { Command, CommandType } from '../../src/sim/commands.ts';
import type { Policy, PolicyContext } from './index.ts';

export function createRandomPolicy(): Policy {
  return {
    name: 'random',
    choose({ legal, rng }: PolicyContext): Command {
      const byType = new Map<CommandType, Command[]>();
      const types: CommandType[] = [];
      for (const c of legal) {
        let list = byType.get(c.type);
        if (!list) {
          list = [];
          byType.set(c.type, list);
          types.push(c.type);
        }
        list.push(c);
      }
      const type = rng.pick(types);
      return rng.pick(byType.get(type) as Command[]);
    },
  };
}
