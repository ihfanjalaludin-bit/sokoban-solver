# Sokoban Solver

[![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ihfanjalaludin-bit/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ihfanjalaludin-bit/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

An entry for make.fun's [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty: one program, `main.ts`, answers a whole set of five generated Sokoban levels in a single run, writing each level's moves to `/output/<id>/solution.txt`. Because a level solved in exactly the optimal number of pushes earns ten times what a merely solved level earns, the solver is built around push-optimality, not just solvability.

## How it works

- **Rooms first.** Every level is a one-wide hallway with independent rooms off it, and a box pushed out of its room can never come back, so the level's optimal push count is the sum of its rooms' optima. The solver splits the level into its hallway and rooms, solves each room on its own, and walks the player along the hallway between rooms. If a level ever has a different shape, it falls back to solving the level whole.
- **Search over pushes, not steps.** Each room is solved with an A* search whose states are the box positions plus the region the player can reach without pushing, and whose moves are single pushes. The cost tracked is the push count itself — exactly what the score rewards.
- **A matching heuristic.** The estimate for a state is a minimum-cost matching between boxes and goals, using precomputed box-to-goal push distances (each computed by a reverse search that ignores the other boxes). The estimate never overstates the pushes still needed, so the first solution the search settles on is provably push-optimal.
- **Deadlock pruning.** Static dead squares (cells from which no box can ever reach a goal), a freeze-deadlock fixpoint, and a 2×2-block check cut away pushes that can never lead to a solution.
- **Deterministic by construction.** The search is budgeted by expanded states, never by the clock, and nothing in the program reads the time or any other source of variation, so repeated runs produce byte-identical answers. If the optimal search ever exhausts its budget, a greedier weighted search still returns a complete solution rather than none.

## Running it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Each instance's answer lands in `out/<id>/solution.txt` as a string of `u`, `d`, `l`, `r` moves (an upper-case letter marks a step that pushes a box).

## License

MIT — see `LICENSE`.
