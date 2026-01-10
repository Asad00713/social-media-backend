#!/bin/bash

# Fix billing.controller.ts - import type
sed -i 's/import {$/import type { RawBodyRequest } from '"'"'@nestjs\/common'"'"';\nimport {/' src/billing/billing.controller.ts
sed -i '/RawBodyRequest,/d' src/billing/billing.controller.ts
sed -i "s/} from '@nestjs\/common';$/} from '@nestjs\/common';/" src/billing/billing.controller.ts
sed -i "s/import { Request } from 'express';/import type { Request } from 'express';/" src/billing/billing.controller.ts

echo "Type fixes applied!"
