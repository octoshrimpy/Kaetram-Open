import _ from 'lodash';

import Player from '../../game/entity/character/player/player';
import World from '../../game/world';
import Messages from '../../network/messages';
import Packets from '@kaetram/common/src/packets';
import Utils from '../../util/utils';
import Minigame, { MinigameState } from '../minigame';

type Team = 'red' | 'blue' | 'lobby';

interface TeamWarState extends MinigameState {
    team: Team;
}

export default class TeamWar extends Minigame {
    world: World;

    lobby: Player[];
    redTeam: Player[];
    blueTeam: Player[];

    updateInterval: NodeJS.Timeout;

    started: boolean;

    countdown: number;
    updateTick: number;
    lastSync: number;
    syncThreshold: number;

    constructor(world: World) {
        super(0, 'TeamWar');

        this.world = world;

        this.lobby = [];
        this.redTeam = [];
        this.blueTeam = [];

        this.updateInterval = null;
        this.started = false;

        this.countdown = 120;
        this.updateTick = 1000;
        this.lastSync = Date.now();
        this.syncThreshold = 10000;

        this.load();
    }

    load(): void {
        this.updateInterval = setInterval(() => {
            if (this.count() < 5 || this.countdown > 0) return;

            this.buildTeams();

            if (Date.now() - this.lastSync > this.syncThreshold) this.synchronize();

            this.started = true;
        }, this.updateTick);
    }

    // start(): void {}

    add(player: Player): void {
        if (this.lobby.includes(player)) return;

        this.lobby.push(player);

        player.minigame = this.getState(player);
    }

    remove(player: Player): void {
        let index = this.lobby.indexOf(player);

        if (index < 0) return;

        this.lobby.splice(index, 1);
    }

    /**
     * Splits the players in the lobby into two groups.
     * These will be the two teams we are creating and
     * sending into the game map.
     */

    buildTeams(): void {
        let tmp = [...this.lobby],
            half = Math.ceil(tmp.length / 2),
            random = Utils.randomInt(0, 1);

        if (random === 1) (this.redTeam = tmp.splice(0, half)), (this.blueTeam = tmp);
        else (this.blueTeam = tmp.splice(0, half)), (this.redTeam = tmp);
    }

    count(): number {
        return this.lobby.length;
    }

    synchronize(): void {
        if (this.started) return;

        _.each(this.lobby, (player: Player) => {
            this.sendCountdown(player);
        });
    }

    sendCountdown(player: Player): void {
        /**
         * We handle this logic client-sided. If a countdown does not exist,
         * we create one, otherwise we synchronize it with the packets we receive.
         */

        this.world.push(Packets.PushOpcode.Player, {
            player,
            message: new Messages.Minigame(Packets.MinigameOpcode.TeamWar, {
                opcode: Packets.MinigameOpcode.TeamWarOpcode.Countdown,
                countdown: this.countdown
            })
        });
    }

    inLobby(player: Player): boolean {
        // TODO - Update these when new lobby is available.
        return player.x > 0 && player.x < 10 && player.y > 10 && player.y < 0;
    }

    // Used for radius
    getRandom(radius?: number): number {
        return Utils.randomInt(0, radius || 4);
    }

    getTeam(player: Player): Team {
        if (this.redTeam.includes(player)) return 'red';

        if (this.blueTeam.includes(player)) return 'blue';

        if (this.lobby.includes(player)) return 'lobby';

        return null;
    }

    // Both these spawning areas randomize the spawning to a radius of 4
    // The spawning area for the red team
    getRedTeamSpawn(): Pos {
        return {
            x: 133 + this.getRandom(),
            y: 471 + this.getRandom()
        };
    }

    // The spawning area for the blue team
    getBlueTeamSpawn(): Pos {
        return {
            x: 163 + this.getRandom(),
            y: 499 + this.getRandom()
        };
    }

    // Expand on the super `getState()`
    getState(player?: Player): TeamWarState {
        let state = super.getState() as TeamWarState;

        // Player can only be in team `red`, `blue`, or `lobby`.
        state.team = this.getTeam(player);

        if (!state.team) return null;

        return state;
    }
}
