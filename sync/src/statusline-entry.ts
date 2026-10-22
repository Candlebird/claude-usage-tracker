#!/usr/bin/env node
// Dedicated statusline entry. dist/statusline.js also self-runs when executed directly, which is
// what the installer points Claude Code at; neither loads the full CLI.
import { statuslineMain } from './statusline.js';

void statuslineMain();
