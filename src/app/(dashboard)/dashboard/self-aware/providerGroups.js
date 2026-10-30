export function activeCooldowns(cooldowns, now) {
  return cooldowns.filter((cooldown) =>
    (cooldown.expiresAtMs || new Date(cooldown.expiresAt).getTime()) > now
  );
}

export function groupCooldownProviders(cooldowns) {
  const providers = new Map();
  for (const cooldown of cooldowns) {
    if (!cooldown.provider) continue;
    const group = providers.get(cooldown.provider) || { provider: cooldown.provider, count: 0 };
    group.count += 1;
    providers.set(cooldown.provider, group);
  }
  return [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export function filterProviderCooldowns(cooldowns, provider) {
  return provider ? cooldowns.filter((cooldown) => cooldown.provider === provider) : [];
}
