<?php

namespace App\RequestLayer;

use Illuminate\Support\Str;

/**
 * What the house can do. Spoken targets resolve here, never in the splitter.
 *
 * Wired today: ha_turn_off, ha_turn_on, spotify_play.
 * Catalogued and unwired: ha_set_temperature (no climate tool in the house registry).
 * High risk (locks, money, sending messages) is recorded and not run.
 */
final class HouseCapabilityCatalog
{
    public function match(string $domain, string $action, string $target): ?HouseCapability
    {
        $domain = Str::lower(trim($domain));
        $action = Str::lower(trim($action));
        $spoken = $this->normalize($target);

        foreach ($this->all() as $capability) {
            if ($capability->domain !== $domain || $capability->action !== $action) {
                continue;
            }

            if ($capability->queryTarget) {
                return $spoken === '' ? null : $capability;
            }

            if (in_array($spoken, $capability->spokenTargets, true)) {
                return $capability;
            }
        }

        return null;
    }

    /**
     * @return list<HouseCapability>
     */
    public function all(): array
    {
        $timeout = $this->timeout();
        $lights = $this->entity('lights', 'bedroom_light');
        $ac = $this->entity('ac', 'climate.air_conditioner');
        $lock = $this->entity('lock', 'lock.front_door');
        $device = $this->spotifyDevice();

        return [
            new HouseCapability(
                domain: 'physical',
                action: 'off',
                spokenTargets: ['lights', 'light', 'bedroom lights', 'bedroom light'],
                queryTarget: false,
                tool: 'ha_turn_off',
                entity: $lights,
                risk: HouseRisk::Low,
                timeoutSeconds: $timeout,
                recommendedBuild: 'ha_turn_off is already a house tool. Wire HouseActionClient if this ask still needs a build.',
            ),
            new HouseCapability(
                domain: 'physical',
                action: 'on',
                spokenTargets: ['lights', 'light', 'bedroom lights', 'bedroom light'],
                queryTarget: false,
                tool: 'ha_turn_on',
                entity: $lights,
                risk: HouseRisk::Low,
                timeoutSeconds: $timeout,
                recommendedBuild: 'ha_turn_on is already a house tool. Wire HouseActionClient if this ask still needs a build.',
            ),
            new HouseCapability(
                domain: 'media',
                action: 'play',
                spokenTargets: [],
                queryTarget: true,
                tool: 'spotify_play',
                entity: $device,
                risk: HouseRisk::Low,
                timeoutSeconds: $timeout,
                recommendedBuild: 'spotify_play on Thor is already a house tool. Wire HouseActionClient if this ask still needs a build.',
            ),
            new HouseCapability(
                domain: 'climate',
                action: 'set_temperature',
                spokenTargets: ['ac', 'a/c', 'air conditioner', 'bedroom ac'],
                queryTarget: false,
                tool: 'ha_set_temperature',
                entity: $ac,
                risk: HouseRisk::Low,
                timeoutSeconds: $timeout,
                recommendedBuild: 'Wire Home Assistant climate.set_temperature as ha_set_temperature and read the target temperature back.',
            ),
            new HouseCapability(
                domain: 'physical',
                action: 'lock',
                spokenTargets: ['front door', 'door'],
                queryTarget: false,
                tool: 'ha_lock',
                entity: $lock,
                risk: HouseRisk::High,
                timeoutSeconds: $timeout,
                recommendedBuild: 'Wire a lock tool for the front door. It stays awaiting yes until the approval item is cleared.',
            ),
            new HouseCapability(
                domain: 'money',
                action: 'send',
                spokenTargets: [],
                queryTarget: true,
                tool: 'money_send',
                entity: 'money',
                risk: HouseRisk::High,
                timeoutSeconds: $timeout,
                recommendedBuild: 'Wire a money tool. It stays awaiting yes until the approval item is cleared.',
            ),
            new HouseCapability(
                domain: 'message',
                action: 'send',
                spokenTargets: [],
                queryTarget: true,
                tool: 'mattermost_create_post',
                entity: 'mattermost',
                risk: HouseRisk::High,
                timeoutSeconds: $timeout,
                recommendedBuild: 'mattermost_create_post already exists. The request layer does not run it until the approval item is cleared.',
            ),
        ];
    }

    private function normalize(string $target): string
    {
        $normalized = Str::of($target)->lower()->squish()->toString();
        $stripped = preg_replace('/^(the|a|an)\s+/u', '', $normalized);

        return is_string($stripped) && $stripped !== '' ? $stripped : $normalized;
    }

    private function timeout(): int
    {
        $value = config('house_request.timeout_seconds', 60);
        $seconds = is_numeric($value) ? (int) $value : 60;

        return max(1, $seconds);
    }

    private function entity(string $key, string $default): string
    {
        $value = config('house_request.entities.'.$key, $default);

        return is_string($value) && trim($value) !== '' ? trim($value) : $default;
    }

    private function spotifyDevice(): string
    {
        $value = config('house_request.spotify_device', 'thor');

        return is_string($value) && trim($value) !== '' ? trim($value) : 'thor';
    }
}
