let Modules = require('../../../../../../util/modules'),
    Formulas = require('../../../../../../util/formulas'),
    Constants = require('../../../../../../util/constants'),
    Messages = require('../../../../../../network/messages'),
    Packets = require('../../../../../../network/packets');

class Profession {

    constructor(id, player, name) {
        let self = this;

        self.id = id;
        self.player = player;
        self.name = name; // The profession name

        self.world = player.world;

        self.map = self.world.map;
        self.region = self.world.region;

        self.experience = 0;
        self.level = Formulas.expToLevel(self.experience);

        self.targetId = null;
    }

    load(data) {
        this.experience = data.experience;
    }

    addExperience(experience) {
        var self = this;

        self.experience += experience;

        let oldLevel = self.level;

        self.level = Formulas.expToLevel(self.experience);
        self.nextExperience = Formulas.nextExp(self.experience);
        self.prevExperience = Formulas.prevExp(self.experience);

        if (oldLevel !== self.level)
            self.player.popup('Profession Level Up!', `Congratulations, your ${self.name} level is now ${self.level}.`, '#9933ff');

        self.player.send(new Messages.Experience(Packets.ExperienceOpcode.Profession, {
            id: self.player.instance,
            amount: experience
        }));

        self.player.save();
    }

    stop() {
        return 'Not implemented.';
    }

    getLevel() {
        let self = this,
            level = Formulas.expToLevel(self.experience);

        if (level > Constants.MAX_PROFESSION_LEVEL)
            level = Constants.MAX_PROFESSION_LEVEL;

        return level;
    }

    isTarget() {
        return this.player.target === this.targetId;
    }

    getData() {
        return {
            experience: this.experience
        }
    }
}

module.exports = Profession;