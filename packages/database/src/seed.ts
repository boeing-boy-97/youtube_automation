/**
 * Seed script.
 *
 * Deliberately creates NO user, NO password and NO business configuration.
 * The only rows inserted are the *catalogue* of selectable subtitle presets and
 * the empty configuration keys the setup wizard writes into. Selecting a preset
 * and every processing value remains an explicit administrator action.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SYSTEM_PRESETS = [
  {
    name: 'Bold Center Pop',
    style: {
      fontFamily: 'Inter',
      fontSizePx: 72,
      fontWeight: 800,
      primaryColor: '#FFFFFF',
      highlightColor: '#FFE066',
      outlineColor: '#101014',
      outlineWidth: 5,
      shadow: 2,
      position: 'middle',
      safeMarginXPx: 90,
      safeMarginBottomPx: 480,
      backgroundOpacity: 0,
      uppercase: true,
      maxCharsPerLine: 18,
      maxLines: 2,
    },
  },
  {
    name: 'Editorial Lower Third',
    style: {
      fontFamily: 'Inter',
      fontSizePx: 54,
      fontWeight: 600,
      primaryColor: '#FFFFFF',
      highlightColor: '#7DD3FC',
      outlineColor: '#000000',
      outlineWidth: 3,
      shadow: 3,
      position: 'lower-third',
      safeMarginXPx: 80,
      safeMarginBottomPx: 260,
      backgroundOpacity: 0.45,
      uppercase: false,
      maxCharsPerLine: 26,
      maxLines: 2,
    },
  },
  {
    name: 'Minimal Caption',
    style: {
      fontFamily: 'Inter',
      fontSizePx: 46,
      fontWeight: 500,
      primaryColor: '#F8FAFC',
      highlightColor: '#F8FAFC',
      outlineColor: '#000000',
      outlineWidth: 2,
      shadow: 1,
      position: 'lower-third',
      safeMarginXPx: 110,
      safeMarginBottomPx: 200,
      backgroundOpacity: 0,
      uppercase: false,
      maxCharsPerLine: 30,
      maxLines: 2,
    },
  },
  {
    name: 'Karaoke Highlight',
    style: {
      fontFamily: 'Inter',
      fontSizePx: 64,
      fontWeight: 800,
      primaryColor: '#FFFFFF',
      highlightColor: '#22D3EE',
      outlineColor: '#0B1120',
      outlineWidth: 6,
      shadow: 0,
      position: 'middle',
      safeMarginXPx: 90,
      safeMarginBottomPx: 460,
      backgroundOpacity: 0.2,
      uppercase: false,
      maxCharsPerLine: 20,
      maxLines: 2,
    },
  },
];

async function main() {
  for (const preset of SYSTEM_PRESETS) {
    const existing = await prisma.subtitlePreset.findFirst({ where: { workspaceId: null, name: preset.name } });
    if (existing) {
      await prisma.subtitlePreset.update({ where: { id: existing.id }, data: { style: preset.style } });
    } else {
      await prisma.subtitlePreset.create({ data: { name: preset.name, isSystem: true, style: preset.style } });
    }
  }
  const users = await prisma.user.count();
  const presets = await prisma.subtitlePreset.count();
  console.log(`[seed] subtitle presets available: ${presets}`);
  console.log(`[seed] users in database: ${users}`);
  if (users === 0) {
    console.log('[seed] No administrator exists. Bootstrap one with:');
    console.log('[seed]   POST /api/auth/bootstrap { bootstrapToken, email, password, displayName, workspaceName }');
    console.log('[seed]   bootstrapToken must equal ADMIN_BOOTSTRAP_TOKEN from the environment.');
  }
  console.log('[seed] No application configuration was written — the setup wizard must supply it explicitly.');
}

main()
  .catch((error) => {
    console.error('[seed] failed', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
