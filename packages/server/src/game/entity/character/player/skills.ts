import _ from 'lodash-es';

import Player from './player';
import Skill from './skill/skill';
import Accuracy from './skill/impl/accuracy';
import Archery from './skill/impl/archery';
import Health from './skill/impl/health';
import Lumberjacking from './skill/impl/lumberjacking';
import Magic from './skill/impl/magic';
import Strength from './skill/impl/strength';

import Formulas from '../../../../info/formulas';

import { Modules, Opcodes } from '@kaetram/common/network';
import { SerializedSkills, SkillData } from '@kaetram/common/types/skills';
import { Experience, Skill as SkillPacket, Points } from '@kaetram/server/src/network/packets';

export default class Skills {
    private loaded = false;

    private accuracy: Accuracy = new Accuracy();
    private archery: Archery = new Archery();
    private health: Health = new Health();
    private lumberjacking: Lumberjacking = new Lumberjacking();
    private magic: Magic = new Magic();
    private strength: Strength = new Strength();

    private skills: { [key: string]: Skill } = {
        [Modules.Skills.Accuracy]: this.accuracy,
        [Modules.Skills.Archery]: this.archery,
        [Modules.Skills.Health]: this.health,
        [Modules.Skills.Lumberjacking]: this.lumberjacking,
        [Modules.Skills.Magic]: this.magic,
        [Modules.Skills.Strength]: this.strength
    };

    private loadCallback?: () => void;

    public constructor(private player: Player) {}

    /**
     * Iterates through the data from the database and finds the
     * matching skill based on the type. Loads the experience into
     * that skill if found.
     * @param data Raw database data containing skill type and experience.
     */

    public load(data: SkillData[]): void {
        // Load each skill from the database (empty if new player).
        _.each(data, (skillData: SkillData) => {
            let skill = this.get(skillData.type);

            if (skill) skill.setExperience(skillData.experience);
        });

        // Create a callback that links to `handleExperience` for every skill.
        this.forEachSkill((skill: Skill) => skill.onExperience(this.handleExperience.bind(this)));

        this.loaded = true;

        this.loadCallback?.();
        this.sync();
    }

    /**
     * Synchronizes the player's health, mana, and level with the client and sends
     * all the necessary packets.
     */

    public sync(): void {
        // Prevent a sync prior to loading from messing up player information.
        if (!this.loaded) return;

        let health = this.get(Modules.Skills.Health),
            magic = this.get(Modules.Skills.Magic);

        // Update max hit points and mana.
        this.player.hitPoints.setMaxHitPoints(Formulas.getMaxHitPoints(health.level));
        this.player.mana.setMaxMana(Formulas.getMaxMana(magic.level));

        // Update the player's level.
        this.player.level = this.getCombatLevel();

        // Synchronize the player's level packet.
        this.player.send(
            new Experience(Opcodes.Experience.Sync, {
                instance: this.player.instance,
                level: this.player.level
            })
        );

        // Synchronize mana and hit points.
        this.player.send(
            new Points({
                instance: this.player.instance,
                hitPoints: this.player.hitPoints.getHitPoints(),
                maxHitPoints: this.player.hitPoints.getMaxHitPoints(),
                mana: this.player.mana.getMana(),
                maxMana: this.player.mana.getMaxMana()
            })
        );
    }

    /**
     * Skills such as lumberjacking may have loops that need to be stopped
     * whenever an action such as movement or being attacked occurs. This is
     * an overload function that calls the stop() function on all skills.
     */

    public stop(): void {
        this.forEachSkill((skill: Skill) => skill.stop());
    }

    /**
     * Handles skill-based experience gain.
     * @param type The skill that gained experience.
     * @param name The name of the skill.
     * @param experience The amount of experience the skill has.
     * @param level The amount of levels the skill has.
     * @param newLevel Whether the player has gained a new level.
     */

    private handleExperience(
        type: Modules.Skills,
        name: string,
        experience: number,
        level: number,
        newLevel?: boolean
    ): void {
        if (newLevel) {
            this.player.popup(
                'Skill level up!',
                `Congratulations, your ${name} has reached level ${level}!`,
                '#9933ff'
            );

            // Update the player's max health if they have gained a level in health skill.
            if (type === Modules.Skills.Health)
                this.player.setHitPoints(Formulas.getMaxHitPoints(level));

            // Update the player's level if they have gained a level in a combat skill.
            this.sync();
        }

        this.player.send(
            new Experience(Opcodes.Experience.Skill, {
                instance: this.player.instance,
                amount: experience,
                skill: type
            })
        );

        this.player.send(new SkillPacket(Opcodes.Skill.Update, this.skills[type].serialize(true)));
    }

    /**
     * Grabs a skill from our dictionary of skills based on its type.
     * @param type The skill type identifier to get.
     * @returns The instance of the skill if found, otherwise undefined.
     */

    public get(type: Modules.Skills): Skill {
        return this.skills[type];
    }

    /**
     * Gets the combat skills of the player and returns an array.
     * @returns An array of all the combat-related skills.
     */

    public getCombatSkills(): Skill[] {
        return _.filter(this.skills, (skill: Skill) => skill.combat);
    }

    /**
     * Shortcut function for grabbing the lumberjacking instance.
     * @returns The lumberjacking class instance.
     */

    public getLumberjacking(): Lumberjacking {
        return this.lumberjacking;
    }

    /**
     * Calculates the total combat level by adding up all the combat-related skill levels. We subtract 1 from
     * each skill in order to keep the combat level at 1 when the player has 1 in all combat skills.
     * @returns Number representing the total combat level.
     */

    public getCombatLevel(): number {
        let level = 1,
            skills = this.getCombatSkills();

        // Faster than using lodash.
        for (let i = 0; i < skills.length; i++) level += skills[i].level - 1;

        return level;
    }

    /**
     * Iterates through all the skills and serializes their data.
     * The data is stored in an array so that it can be parsed.
     * @param includeLevel Whether to include the level in the serialized data.
     * @returns Array containing data for each skill (at each index).
     */

    public serialize(includeLevel = false): SerializedSkills {
        let skills: SkillData[] = [];

        this.forEachSkill((skill: Skill) => skills.push(skill.serialize(includeLevel)));

        return {
            skills
        };
    }

    /**
     * Iterates through all the skills and creates a callback.
     * @param callback Contains skill being iterated currently.
     */

    public forEachSkill(callback: (skill: Skill) => void): void {
        _.each(this.skills, callback);
    }

    /**
     * Callback for when the skills are loaded from the database,
     * a batch data of skills is sent to the client.
     */

    public onLoaded(callback: () => void): void {
        this.loadCallback = callback;
    }
}