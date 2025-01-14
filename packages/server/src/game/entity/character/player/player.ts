import _ from 'lodash';

import config from '@kaetram/common/config';
import { Modules, Opcodes } from '@kaetram/common/network';
import log from '@kaetram/common/util/log';
import Utils from '@kaetram/common/util/utils';

import Incoming from '../../../../controllers/incoming';
import Quests from '../../../../controllers/quests';
import Formulas from '../../../../info/formulas';
import Character from '../character';
import Hit from '../combat/hit';
import Abilities from './abilities/abilities';
import Bank from './containers/impl/bank';
import Inventory from './containers/impl/inventory';
import Doors from './doors';
import Enchant from './enchant';
import Friends from './friends';
import Handler from './handler';
import Mana from '../points/mana';
import Trade from './trade';
import Warp from './warp';

import type { ExperienceCombatData } from '@kaetram/common/types/messages';
import type MongoDB from '../../../../database/mongodb/mongodb';
import type Area from '../../../map/areas/area';
import type Connection from '../../../../network/connection';
import type World from '../../../world';
import type NPC from '../../npc/npc';
import type { PlayerInfo } from './../../../../database/mongodb/creator';
import type Introduction from './quests/impl/introduction';
import Map from '../../../map/map';
import { PacketType } from '@kaetram/common/network/modules';
import {
    Audio,
    Bubble,
    Camera,
    Chat,
    Death,
    Equipment as EquipmentPacket,
    Experience,
    Heal,
    Movement,
    Notification,
    Overlay,
    Quest,
    Sync,
    Teleport,
    Welcome
} from '@kaetram/server/src/network/packets';
import Packet from '@kaetram/server/src/network/packet';
import Equipments from './equipment/equipments';
import Regions from '../../../map/regions';
import Entities from '@kaetram/server/src/controllers/entities';
import GlobalObjects from '@kaetram/server/src/controllers/globalobjects';
import { EntityData } from '../../entity';
import { EquipmentData } from '@kaetram/common/types/equipment';
import Container from './containers/container';
import Item from '../../objects/item';
import { SlotData, SlotType } from '@kaetram/common/types/slot';
import Slot from './containers/slot';

type TeleportCallback = (x: number, y: number, isDoor: boolean) => void;
type KillCallback = (character: Character) => void;
type InterfaceCallback = (state: boolean) => void;
type NPCTalkCallback = (npc: NPC) => void;
type DoorCallback = (x: number, y: number) => void;

export interface PlayerRegions {
    regions: string;
    gameVersion: string;
}

export interface ObjectData {
    [index: number]: {
        isObject: boolean;
        cursor: string | undefined;
    };
}

interface PlayerData extends EntityData {
    rights: number;
    pvp: boolean;
    orientation: number;

    equipments: EquipmentData[];
}

export default class Player extends Character {
    public map: Map;
    private regions: Regions;
    private entities: Entities;
    private globalObjects: GlobalObjects;

    public incoming: Incoming;

    private handler: Handler;

    public equipment: Equipments;
    public inventory: Inventory;
    public bank: Bank;

    public ready = false; // indicates if login processed finished

    public password = '';
    public email = '';

    public rights = 0;
    public experience = 0;
    public ban = 0; // epoch timestamp
    public mute = 0;
    public lastLogin = 0;
    public pvpKills = 0;
    public pvpDeaths = 0;
    public orientation = Modules.Orientation.Down;
    public mapVersion = -1;

    // TODO - REFACTOR THESE ------------

    public abilities;
    public friends;
    public enchant;
    public quests;
    public trade;
    public doors;
    public warp;

    public team?: string; // TODO
    public userAgent!: string;

    private disconnectTimeout: NodeJS.Timeout | null = null;
    private timeoutDuration = 1000 * 60 * 10; // 10 minutes
    public lastRegionChange = Date.now();

    private currentSong: string | null = null;
    public isGuest = false;

    public canTalk = true;
    public webSocketClient;

    public talkIndex = 0;
    public cheatScore = 0;
    public defaultMovementSpeed = 250; // For fallback.

    public regionsLoaded: number[] = [];
    public lightsLoaded: number[] = [];

    public npcTalk = '';

    private nextExperience: number | undefined;
    private prevExperience!: number;

    public mana: Mana = new Mana(Modules.Defaults.MANA);

    public profileDialogOpen?: boolean;
    public inventoryOpen?: boolean;
    public warpOpen?: boolean;

    public cameraArea: Area | undefined;
    private overlayArea: Area | undefined;

    private permanentPVP = false;
    public movementStart!: number;

    public pingTime!: number;

    public questsLoaded = false;
    public achievementsLoaded = false;

    public new = false;
    private lastNotify!: number;

    public selectedShopItem!: { id: number; index: number } | null;

    //--------------------------------------

    private teleportCallback?: TeleportCallback;
    private cheatScoreCallback?(): void;
    private profileToggleCallback?: InterfaceCallback;
    private inventoryToggleCallback?: InterfaceCallback;
    private warpToggleCallback?: InterfaceCallback;
    private orientationCallback?(): void;
    private killCallback?: KillCallback;
    public npcTalkCallback?: NPCTalkCallback;
    public doorCallback?: DoorCallback;
    public readyCallback?(): void;

    public constructor(world: World, public database: MongoDB, public connection: Connection) {
        super(connection.id, world, '', -1, -1);

        this.map = world.map;
        this.regions = world.map.regions;
        this.entities = world.entities;
        this.globalObjects = world.globalObjects;

        this.incoming = new Incoming(this);

        this.equipment = new Equipments(this);

        this.bank = new Bank(Modules.Constants.BANK_SIZE);
        this.inventory = new Inventory(Modules.Constants.INVENTORY_SIZE);

        this.handler = new Handler(this);

        // TODO - Refactor
        this.abilities = new Abilities(this);
        this.friends = new Friends(this);
        this.enchant = new Enchant(this);
        this.quests = new Quests(this);
        this.trade = new Trade(this);
        this.doors = new Doors(this);
        this.warp = new Warp(this);

        this.webSocketClient = connection.type === 'WebSocket';
    }

    public load(data: PlayerInfo): void {
        this.rights = data.rights;
        this.experience = data.experience;
        this.ban = data.ban;
        this.mute = data.mute;
        this.lastLogin = data.lastLogin;
        this.pvpKills = data.pvpKills;
        this.pvpDeaths = data.pvpDeaths;
        this.orientation = data.orientation;
        this.mapVersion = data.mapVersion;

        this.setPosition(data.x, data.y);

        this.warp.setLastWarp(data.lastWarp);

        this.level = Formulas.expToLevel(this.experience);
        this.nextExperience = Formulas.nextExp(this.experience);
        this.prevExperience = Formulas.prevExp(this.experience);

        this.userAgent = data.userAgent;

        // TODO - Do not calculate max points on every login, just store it instead.
        this.hitPoints.updateHitPoints([data.hitPoints, Formulas.getMaxHitPoints(this.level)]);
        this.mana.updateMana([data.mana, Formulas.getMaxMana(this.level)]);

        this.intro();
    }

    /**
     * Loads the equipment data from the database.
     */

    public loadEquipment(): void {
        this.database.loader?.loadEquipment(this, this.equipment.load.bind(this.equipment));
    }

    /**
     * Loads the inventory data from the database.
     */

    public loadInventory(): void {
        this.database.loader?.loadInventory(this, this.inventory.load.bind(this.inventory));
    }

    /**
     * Loads the bank data from the database.
     */

    public loadBank(): void {
        this.database.loader?.loadBank(this, this.bank.load.bind(this.bank));
    }

    // ---------------- REFACTOR --------------------

    public loadRegions(regions: PlayerRegions): void {
        //TODO REFACTOR
        // if (!regions) return;
        // if (this.mapVersion !== this.map.version) {
        //     this.mapVersion = this.map.version;
        //     this.save();
        //     log.debug(`Updated map version for ${this.username}`);
        //     return;
        // }
        // if (regions.gameVersion === config.gver) this.regionsLoaded = regions.regions.split(',');
    }

    public loadFriends(): void {
        //
    }

    public loadQuests(): void {
        //
    }

    // ---------------- REFACTOR EMD --------------------

    public destroy(): void {
        if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);

        this.disconnectTimeout = null;

        this.handler.destroy();

        this.handler = null!;
        this.inventory = null!;
        this.abilities = null!;
        this.enchant = null!;
        this.bank = null!;
        this.quests = null!;
        this.trade = null!;
        this.doors = null!;
        this.warp = null!;

        this.connection = null!;
    }

    public intro(): void {
        if (this.ban > Date.now()) {
            this.connection.sendUTF8('ban');
            this.connection.close(`Player: ${this.username} is banned.`);
        }

        if (this.x <= 0 || this.y <= 0) this.sendToSpawn();

        if (this.hitPoints.getHitPoints() < 0) this.hitPoints.setHitPoints(this.getMaxHitPoints());

        if (this.mana.getMana() < 0) this.mana.setMana(this.mana.getMaxMana());

        this.verifyRights();

        let info = {
            instance: this.instance,
            username: Utils.formatUsername(this.username),
            x: this.x,
            y: this.y,
            rights: this.rights,
            hitPoints: this.hitPoints.serialize(),
            mana: this.mana.serialize(),
            experience: this.experience,
            nextExperience: this.nextExperience,
            prevExperience: this.prevExperience,
            level: this.level,
            lastLogin: this.lastLogin,
            pvpKills: this.pvpKills,
            pvpDeaths: this.pvpDeaths,
            orientation: this.orientation,
            movementSpeed: this.getMovementSpeed()
        };

        /**
         * Send player data to client here
         */

        this.entities.addPlayer(this);

        this.send(new Welcome(info));
    }

    private verifyRights(): void {
        if (config.moderators.includes(this.username.toLowerCase())) this.rights = 1;

        if (config.administrators.includes(this.username.toLowerCase()) || config.skipDatabase)
            this.rights = 2;
    }

    public addExperience(exp: number): void {
        this.experience += exp;

        let oldLevel = this.level;

        this.level = Formulas.expToLevel(this.experience);
        this.nextExperience = Formulas.nextExp(this.experience);
        this.prevExperience = Formulas.prevExp(this.experience);

        if (oldLevel !== this.level) {
            this.hitPoints.setMaxHitPoints(Formulas.getMaxHitPoints(this.level));
            this.healHitPoints(this.hitPoints.maxPoints);

            this.updateRegion();

            this.popup('Level Up!', `Congratulations, you are now level ${this.level}!`, '#ff6600');
        }

        let data = {
            id: this.instance,
            level: this.level
        } as ExperienceCombatData;

        /**
         * Sending two sets of data as other users do not need to
         * know the experience of another player.. (yet).
         */

        this.sendToRegions(new Experience(Opcodes.Experience.Combat, data), true);

        data.amount = exp;
        data.experience = this.experience;
        data.nextExperience = this.nextExperience;
        data.prevExperience = this.prevExperience;

        this.send(new Experience(Opcodes.Experience.Combat, data));

        this.sync();
    }

    /**
     * Passed from the superclass...
     */
    public override heal(amount: number): void {
        super.heal(amount);

        this.mana.increment(amount);

        this.sync();
    }

    public healHitPoints(amount: number): void {
        let type = 'health' as const;

        this.hitPoints.increment(amount);

        this.sync();

        this.sendToRegions(
            new Heal({
                id: this.instance,
                type,
                amount
            })
        );
    }

    public healManaPoints(amount: number): void {
        let type = 'mana' as const;

        this.mana.increment(amount);

        this.sync();

        this.sendToRegions(
            new Heal({
                id: this.instance,
                type,
                amount
            })
        );
    }

    public eat(id: number): void {
        log.warning('player.eat() reimplement.');
    }

    public updateRegion(force = false): void {
        this.regions.sendRegion(this);
    }

    public canEquip(string: string): boolean {
        return false;
    }

    public die(): void {
        this.dead = true;

        this.deathCallback?.();

        this.send(new Death(this.instance));
    }

    public teleport(x: number, y: number, isDoor = false, withAnimation = false): void {
        this.teleportCallback?.(x, y, isDoor);

        this.sendToRegions(
            new Teleport({
                id: this.instance,
                x,
                y,
                withAnimation
            })
        );

        this.setPosition(x, y);
        this.world.cleanCombat(this);
    }

    /**
     * We route all object clicks through the player instance
     * in order to organize data more neatly.
     */
    public handleObject(id: string): void {
        let info = this.globalObjects.getInfo(id);

        if (!info) return;

        switch (info.type) {
            case 'sign': {
                let data = this.globalObjects.getSignData(id);

                if (!data) return;

                let text = this.globalObjects.talk(data.object, this);

                this.send(
                    new Bubble({
                        id,
                        text,
                        duration: 5000,
                        isObject: true,
                        info: data.info
                    })
                );

                break;
            }
        }
    }

    public handleBankOpen(): void {
        //
    }

    /**
     * Handles the select event when clicking a container.
     * @param container The container we are handling.
     * @param index The index in the container we selected.
     */

    public handleContainerSelect(container: Container, index: number, slotType?: SlotType): void {
        let slot: SlotData | undefined, item: Item;

        log.debug(`Received container select: ${container.type} - ${index} - ${slotType}`);

        // TODO - Cleanup and document, this is a preliminary prototype.
        switch (container.type) {
            case Modules.ContainerType.Inventory:
                log.debug(`Selected item index: ${index}`);

                slot = container.remove(index);

                if (!slot) return;

                item = container.getItem(slot);

                if (item.isEquippable()) this.equipment.equip(item);

                break;

            case Modules.ContainerType.Bank:
                if (!slotType) return;

                // Move item from the bank to the inventory.
                if (slotType === 'inventory') container.move(this.inventory, index);
                // Move item from the inventory to the bank.
                else if (slotType === 'bank') this.inventory.move(container, index);

                break;
        }
    }

    public incrementCheatScore(amount: number): void {
        if (this.combat.started) return;

        this.cheatScore += amount;

        this.cheatScoreCallback?.();
    }

    public updatePVP(pvp: boolean, permanent = false): void {
        /**
         * No need to update if the state is the same
         */

        if (!this.region) return;

        if (this.pvp === pvp || this.permanentPVP) return;

        if (this.pvp && !pvp) this.notify('You are no longer in a PvP zone!');
        else this.notify('You have entered a PvP zone!');

        this.pvp = pvp;
        this.permanentPVP = permanent;

        // TODO - Redo the packet
        //this.sendToAdjacentRegions(this.region, new PVP(this.instance, this.pvp));
    }

    public updateOverlay(overlay: Area | undefined): void {
        if (this.overlayArea === overlay) return;

        this.overlayArea = overlay;

        if (overlay && overlay.id) {
            this.lightsLoaded = [];

            this.send(
                new Overlay(Opcodes.Overlay.Set, {
                    image: overlay.fog || 'empty',
                    colour: `rgba(0,0,0,${overlay.darkness})`
                })
            );
        } else this.send(new Overlay(Opcodes.Overlay.Remove));
    }

    public updateCamera(camera: Area | undefined): void {
        if (this.cameraArea === camera) return;

        this.cameraArea = camera;

        if (camera)
            switch (camera.type) {
                case 'lockX':
                    this.send(new Camera(Opcodes.Camera.LockX));
                    break;

                case 'lockY':
                    this.send(new Camera(Opcodes.Camera.LockY));
                    break;

                case 'player':
                    this.send(new Camera(Opcodes.Camera.Player));
                    break;
            }
        else this.send(new Camera(Opcodes.Camera.FreeFlow));
    }

    public updateMusic(info?: Area): void {
        if (!info || info.song === this.currentSong) return;

        this.currentSong = info.song;

        this.send(new Audio(info.song));
    }

    public revertPoints(): void {
        this.hitPoints.setHitPoints(this.hitPoints.getMaxHitPoints());
        this.mana.setMana(this.mana.getMaxMana());

        this.sync();
    }

    public toggleProfile(state: boolean): void {
        this.profileDialogOpen = state;

        this.profileToggleCallback?.(state);
    }

    public toggleInventory(state: boolean): void {
        this.inventoryOpen = state;

        this.inventoryToggleCallback?.(state);
    }

    public toggleWarp(state: boolean): void {
        this.warpOpen = state;

        this.warpToggleCallback?.(state);
    }

    public getMana(): number {
        return this.mana.getMana();
    }

    public getMaxMana(): number {
        return this.mana.getMaxMana();
    }

    public override getHitPoints(): number {
        return this.hitPoints.getHitPoints();
    }

    public override getMaxHitPoints(): number {
        return this.hitPoints.getMaxHitPoints();
    }

    public getTutorial(): Introduction {
        return this.quests.getQuest<Introduction>(Modules.Quests.Introduction)!;
    }

    private getMovementSpeed(): number {
        // let itemMovementSpeed = Items.getMovementSpeed(this.armour.name),
        //     movementSpeed = itemMovementSpeed || this.defaultMovementSpeed;

        // /*
        //  * Here we can handle equipment/potions/abilities that alter
        //  * the player's movement speed. We then just broadcast it.
        //  */

        // this.movementSpeed = movementSpeed;

        return this.defaultMovementSpeed;
    }

    /**
     * Setters
     */

    public override setPosition(x: number, y: number): void {
        if (this.dead) return;

        if (this.map.isOutOfBounds(x, y)) {
            x = 50;
            y = 89;
        }

        super.setPosition(x, y);

        this.sendToRegions(
            new Movement(Opcodes.Movement.Move, {
                id: this.instance,
                x,
                y,
                forced: false,
                teleport: false
            }),
            true
        );
    }

    public setOrientation(orientation: number): void {
        this.orientation = orientation;

        if (this.orientationCallback)
            // Will be necessary in the future.
            this.orientationCallback;
    }

    /**
     * Override the `setRegion` in Entity by adding a callback.
     * @param region The new region we are setting.
     */

    public override setRegion(region: number): void {
        super.setRegion(region);
        if (region !== -1) this.regionCallback?.(region);
    }

    /**
     * Getters
     */

    public hasMaxMana(): boolean {
        return this.mana.getMana() >= this.mana.getMaxMana();
    }

    public override hasSpecialAttack(): boolean {
        return false;
    }

    public canBeStunned(): boolean {
        return true;
    }

    /**
     * Serializes the player character to be sent to
     * nearby regions. This contains all the data
     * about the player that other players should
     * be able to see.
     * @returns PlayerData containing all of the player info.
     */

    public override serialize(withEquipment?: boolean): PlayerData {
        let data = super.serialize() as PlayerData;

        data.rights = this.rights;
        data.level = this.level;
        data.hitPoints = this.hitPoints.getHitPoints();
        data.maxHitPoints = this.hitPoints.getMaxHitPoints();
        data.attackRange = this.attackRange;
        data.orientation = this.orientation;
        data.movementSpeed = this.getMovementSpeed();

        // Include equipment only when necessary.
        if (withEquipment) data.equipments = this.equipment.serialize().equipments;

        return data;
    }

    /**
     * Here we will implement functions from quests and
     * other special events and determine a spawn point.
     */
    public getSpawn(): Pos {
        if (!this.finishedTutorial()) return this.getTutorial().getSpawn();

        return { x: 325, y: 87 };
    }

    public getHit(target: Character): Hit | undefined {
        let weapon = this.equipment.getWeapon(),
            defaultDamage = Formulas.getDamage(this, target),
            isSpecial = Utils.randomInt(0, 100) < 30 + weapon.abilityLevel * 3;

        if (!isSpecial || !this.hasSpecialAttack())
            return new Hit(Modules.Hits.Damage, defaultDamage);

        let multiplier: number, damage: number;

        switch (weapon.ability) {
            case Modules.Enchantment.Critical:
                /**
                 * Still experimental, not sure how likely it is that you're
                 * gonna do a critical strike. I just do not want it getting
                 * out of hand, it's easier to buff than to nerf..
                 */

                multiplier = 1 + weapon.abilityLevel;
                damage = defaultDamage * multiplier;

                return new Hit(Modules.Hits.Critical, damage);

            case Modules.Enchantment.Stun:
                return new Hit(Modules.Hits.Stun, defaultDamage);

            case Modules.Enchantment.Explosive:
                return new Hit(Modules.Hits.Explosive, defaultDamage);
        }
    }

    public loadRegion(region: number): void {
        this.regionsLoaded.push(region);
    }

    public hasLoadedRegion(region: number): boolean {
        return this.regionsLoaded.includes(region);
    }

    public hasLoadedLight(light: number): boolean {
        return this.lightsLoaded.includes(light);
    }

    public timeout(): void {
        if (!this.connection) return;

        this.connection.sendUTF8('timeout');
        this.connection.close('Player timed out.');
    }

    public refreshTimeout(): void {
        if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);

        this.disconnectTimeout = setTimeout(() => {
            this.timeout();
        }, this.timeoutDuration);
    }

    public isMuted(): boolean {
        let time = Date.now();

        return this.mute - time > 0;
    }

    public override isDead(): boolean {
        return this.getHitPoints() < 1 || this.dead;
    }

    /**
     * Miscellaneous
     */

    /**
     * We create this function to make it easier to send
     * packets to players instead of always importing `world`
     * in other classes.
     * @param packet Packet we are sending to the player.
     */

    public send(packet: Packet): void {
        this.world.push(PacketType.Player, {
            packet,
            player: this
        });
    }

    /**
     * Sends a packet to all regions surrounding the player.
     * @param packet The packet we are sending to the regions.
     */

    public sendToRegions(packet: Packet, ignore?: boolean): void {
        this.world.push(PacketType.Regions, {
            region: this.region,
            packet,
            ignore: ignore ? this.instance : ''
        });
    }

    public sendToSpawn(): void {
        let position = this.getSpawn();

        this.x = position.x;
        this.y = position.y;
    }

    public sendMessage(playerName: string, message: string): void {
        if (config.hubEnabled) {
            this.world.api.sendPrivateMessage(this, playerName, message);
            return;
        }

        if (!this.world.isOnline(playerName)) {
            this.notify(`@aquamarine@${playerName}@crimson@ is not online.`, 'crimson');
            return;
        }

        let otherPlayer = this.world.getPlayerByName(playerName),
            oFormattedName = Utils.formatUsername(playerName), // Formated username of the other player.
            formattedName = Utils.formatUsername(this.username); // Formatted username of current instance.

        otherPlayer.notify(`[From ${oFormattedName}]: ${message}`, 'aquamarine');
        this.notify(`[To ${formattedName}]: ${message}`, 'aquamarine');
    }

    /**
     * Function to be used for syncing up health,
     * mana, exp, and other variables
     */
    public sync(): void {
        let data = this.serialize(true);

        this.sendToRegions(new Sync(data));

        this.save();
    }

    public popup(title: string, message: string, colour: string): void {
        if (!title) return;

        title = Utils.parseMessage(title);
        message = Utils.parseMessage(message);

        this.send(
            new Notification(Opcodes.Notification.Popup, {
                title,
                message,
                colour
            })
        );
    }

    public notify(message: string, colour?: string): void {
        if (!message) return;

        // Prevent notify spams
        if (Date.now() - this.lastNotify < 250) return;

        message = Utils.parseMessage(message);

        this.send(
            new Notification(Opcodes.Notification.Text, {
                message,
                colour
            })
        );

        this.lastNotify = Date.now();
    }

    /**
     * Sends a chat packet that can be used to
     * show special messages to the player.
     */

    public chat(
        source: string,
        text: string,
        colour?: string,
        isGlobal = false,
        withBubble = false
    ): void {
        if (!source || !text) return;

        this.send(
            new Chat({
                name: source,
                text,
                colour,
                isGlobal,
                withBubble
            })
        );
    }

    /**
     * Forcefully stopping the player will simply halt
     * them in between tiles. Should only be used if they are
     * being transported elsewhere.
     */
    public stopMovement(force = false): void {
        this.send(
            new Movement(Opcodes.Movement.Stop, {
                instance: this.instance,
                force
            })
        );
    }

    public finishedTutorial(): boolean {
        if (!this.quests || !config.tutorialEnabled) return true;

        return this.quests.getQuest(0)!.isFinished();
    }

    public finishedQuest(id: number): boolean {
        let quest = this.quests?.getQuest(id);

        return quest?.isFinished() || false;
    }

    public finishedAchievement(id: number): boolean {
        if (!this.quests) return false;

        let achievement = this.quests.getAchievement(id);

        if (!achievement) return true;

        return achievement.isFinished();
    }

    public finishAchievement(id: number): void {
        if (!this.quests) return;

        let achievement = this.quests.getAchievement(id);

        if (!achievement || achievement.isFinished()) return;

        achievement.finish();
    }

    /**
     * Server-sided callbacks towards movement should
     * not be able to be overwritten. In the case that
     * this is used (for Quests most likely) the server must
     * check that no hacker removed the constraint in the client-side.
     * If they are not within the bounds, apply the according punishment.
     */
    private movePlayer(): void {
        this.send(new Movement(Opcodes.Movement.Started));
    }

    private walkRandomly(): void {
        setInterval(() => {
            this.setPosition(this.x + Utils.randomInt(-5, 5), this.y + Utils.randomInt(-5, 5));
        }, 2000);
    }

    public killCharacter(character: Character): void {
        this.killCallback?.(character);
    }

    public save(): void {
        if (config.skipDatabase || this.isGuest || !this.ready) return;

        this.database.creator?.save(this);
    }

    public inTutorial(): boolean {
        return this.world.map.inTutorialArea(this);
    }

    public hasAggressionTimer(): boolean {
        return Date.now() - this.lastRegionChange < 60_000 * 20; // 20 Minutes
    }

    public onOrientation(callback: () => void): void {
        this.orientationCallback = callback;
    }

    public onKill(callback: KillCallback): void {
        this.killCallback = callback;
    }

    public override onDeath(callback: () => void): void {
        this.deathCallback = callback;
    }

    public onTalkToNPC(callback: NPCTalkCallback): void {
        this.npcTalkCallback = callback;
    }

    public onDoor(callback: DoorCallback): void {
        this.doorCallback = callback;
    }

    public onTeleport(callback: TeleportCallback): void {
        this.teleportCallback = callback;
    }

    public onProfile(callback: InterfaceCallback): void {
        this.profileToggleCallback = callback;
    }

    public onInventory(callback: InterfaceCallback): void {
        this.inventoryToggleCallback = callback;
    }

    public onWarp(callback: InterfaceCallback): void {
        this.warpToggleCallback = callback;
    }

    public onCheatScore(callback: () => void): void {
        this.cheatScoreCallback = callback;
    }

    public onReady(callback: () => void): void {
        this.readyCallback = callback;
    }
}
