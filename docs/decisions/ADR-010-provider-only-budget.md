# Limites du fournisseur sans budget local

Décision du propriétaire du 4 novembre 2026 : retirer le budget local qui met son
agent en hibernation, puis relancer.

Quand une policy explicitement activée porte `subscriptionQuota.providerLimitsOnly:
true`, une jauge de pourcentage ne refuse plus un lancement et n'interrompt plus
une session. La jauge reste informative ; le CLI officiel accepte ou refuse le
tour. Les profils qui choisissent des seuils locaux gardent leur comportement.

Cette décision ne modifie ni Pause, Force-off, les permissions, les plafonds locaux
explicitement choisis ni les refus réels du fournisseur. Un refus de quota ou de
débit continue de déclencher le délai fournisseur et le backoff existants. Aucun
changement de compte, de fournisseur ou d'API payante n'est effectué.
