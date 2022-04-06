//Plugin by MaskedMonkeyMan

import BasePlugin from "./base-plugin.js";

import fs from "fs";
import { Layers } from "../layers/index.js"

function randomElement(array)
{
	return array[Math.floor(Math.random() * array.length)];
}

function formatChoice(choiceIndex, mapString, currentVotes)
{
	return `type !vote ${choiceIndex + 1} : ${mapString} (${currentVotes} votes)`
}

function toMils(min)
{
	return min * 60 * 1000;
}

export default class MapVote extends BasePlugin
{
    static get description() 
    {
        return "Map Voting plugin";
    }
    
    static get defaultEnabled() 
    {
        return true;
    }
    
    static get optionsSpecification() 
    {
        return {
            commandPrefix:
            {
                required: false,
                description: "command name to use in chat",
                default: "!vote"
            },
            voteRulesPath:
            {
                required: false,
                description: 'the path to the layersConfig file',
                default: ''
            },
			minPlayersForVote:
            {
                required: false,
                description: 'number of players needed on the server for a vote to start',
                default: 50
            },
            voteWaitTimeFromMatchStart:
            {
                required: false,
                description: 'time in mils from the start of a round to the start of a new map vote',
                default: 20
            },
            voteBroadcastInterval:
            {
                required: false,
                description: 'broadcast interval for vote notification in mils',
                default: 15
            },
        };
    }
    
    constructor(server, options, connectors)
    {
        super(server, options, connectors);
		
        this.voteRules = {}; //data object holding vote configs
        this.nominations = []; //layer strings for the current vote choices
		this.trackedVotes = {}; //player votes, keyed by steam id
        this.tallies = []; //votes per layer, parellel with nominations
        this.votingEnabled = false;
        this.onConnectBound = false;
        this.broadcastIntervalTask = null;
        
        this.onNewGame = this.onNewGame.bind(this);
        this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
        this.onChatMessage = this.onChatMessage.bind(this);
		this.broadcastNominations = this.broadcastNominations.bind(this);
        this.beginVoting = this.beginVoting.bind(this);

        this.msgBroadcast = (msg) => {this.server.rcon.broadcast(msg);};
        this.msgDirect = (steamid, msg) => {this.server.rcon.warn(steamid, msg);};

        //load voteRules with options from source file
        this.loadLayersConfig();
    }

    async mount()
    {
		this.server.on('NEW_GAME', this.onNewGame);
        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
		this.verbose(1, 'Map vote was mounted.');
    }

    async unmount()
    {
		this.server.removeEventListener('NEW_GAME', this.onNewGame);
        this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
        clearInterval(this.broadcastIntervalTask);
		this.verbose(1, 'Map vote was un-mounted.');
    }
    
    //loads layer configs from disk into plugin memory
    loadLayersConfig()
    {
        this.verbose(1, `Fetching Map Voting Lists...`);
        
        let layersConfigString = '';
        try 
        {
            if (!fs.existsSync(this.options.voteRulesPath)) 
                throw new Error(`Could not find Map Vote List at ${this.options.voteRulesPath}`);
            layersConfigString = fs.readFileSync(this.options.voteRulesPath, 'utf8');
        }
        catch (error) 
        {
            this.verbose('SquadServer', 1, `Error fetching mapvoting list: ${options.voteRulesPath}`, error);
        }

        this.voteRules = JSON.parse(layersConfigString);
    }
    
    async onNewGame()
	{
        //wait to start voting
        this.endVoting();
        this.trackedVotes = {};
        this.tallies = [];
        this.nominations = [];
        setTimeout(this.beginVoting, toMils(this.options.voteWaitTimeFromMatchStart));
	}
    
    async onPlayerDisconnected()
    {
        if (!this.votingEnabled) return;
		await this.server.updatePlayerList();
        this.clearVote();
        this.updateNextMap();
    }

    async onChatMessage(info)
    {
        const {steamID, name: playerName} = info;
        const message = info.message.toLowerCase();
        //check to see if this message has a command prefix
        if (!message.startsWith(this.options.commandPrefix))
            return;
        
        const subCommand = message.substring(this.options.commandPrefix.length).trim();
        if(!isNaN(subCommand)) // if this succeeds player is voting for a map
        {
			const mapNumber = parseInt(subCommand); //try to get a vote number
            if (!this.votingEnabled)
            {
                await this.msgDirect(steamID, "There is no vote running right now");
                return;
            }
            await this.registerVote(steamID, mapNumber, playerName);
            this.updateNextMap();
            return;
        }
        
        const isAdmin = info.chat === "ChatAdmin";
        switch(subCommand) // select the sub command
        {
            case "choices": //sends choices to player in the from of a warning
                if (!this.votingEnabled)
                {
                    await this.msgDirect(steamID, "There is no vote running right now");
                    return;
                }
                this.directMsgNominations(steamID);
                return;
            case "results": //sends player the results in a warning
                if (!this.votingEnabled)
                {
                    await this.msgDirect(steamID, "There is no vote running right now");
                    return;
                }
                this.directMsgNominations(steamID);
                return;
            case "restart": //starts the vote again if it was canceled
                if(!isAdmin) return;
                
                if(this.votingEnabled)
                {
                    await this.msgDirect(steamID, "Voting is already enabled");
                    return;
                }
                this.beginVoting(true);
                return;
            case "cancel": //cancels the current vote and wont set next map to current winnner
                if(!isAdmin) return;
                
                if(!this.votingEnabled)
                {
                    await this.msgDirect(steamID, "Voting is already disabled");
                    return;
                }
                this.endVoting();
				await this.msgDirect(steamID, "ending current vote");
                return;
            case "reload": //allows for config hot reloads
                if(!isAdmin) return;
                
                this.loadLayersConfig();
                await this.msgDirect(steamID, "Reloaded map vote layers configuration")
                return;
            case "help": //displays available commands
                await this.msgDirect(steamID, `!vote <choices|number|results>`);
                if(!isAdmin) return;
                
                await this.msgDirect(steamID, `!vote <restart|cancel|reload> (admin only)`);
                return;
            default:
                //give them an error
                await this.msgDirect(steamID, `Unknown vote subcommand: ${subCommand}`);
                return;
        }
        
    }
    
    updateNextMap() //sets next map to current mapvote winner, if there is a tie will pick at random
    {
        const nextMap = randomElement(this.currentWinners);
        this.server.rcon.execute(`AdminSetNextLayer ${nextMap}`);
    }
    
    //TODO: right now if version is set to "Any" no caf layers will be selected
    populateNominations() //gets nomination strings from layer options
    {
        //helpers
        const splitName = name => name.substring(0, name.lastIndexOf("_"));
        const removeCAF = name => name.replace("CAF_", "");
        const matchLayers = builtString => Layers.layers.filter((element) => element.layerid.startsWith(builtString));

		if (!this.server.currentLayer)
		{
			this.verbose(1, "Error: unknown currentLayer");
			endVoting();
			return;
		}

        this.nominations = [];
        const rulesList = this.voteRules.rules;
        let layerString = this.server.currentLayer.layerid;
        let nominationsList = rulesList.default;
		
        //chomp string until we find a match
        while(layerString.length > 0)
        {
            if(layerString in rulesList)
            {
                nominationsList = rulesList[layerString];
                break;
            }
            layerString = removeCAF(layerString);
            layerString = splitName(layerString);
        }
        
        for(const nomination of nominationsList)
        {
            const mapName = nomination.map;
            let mode = randomElement(nomination.modes);
            let version = randomElement(nomination.versions);
            let cafPrefix = "";

            if (version.includes("CAF_"))
            {
                cafPrefix = "CAF_";
                version = removeCAF(version);
            }

            if (mode === "Any")
            {
                let modes = this.voteRules.modes;
                while (modes.length > 0)
                {
                    mode = randomElement(this.voteRules.modes);
                    modes = modes.filter((elem) => elem !== mode);
                    if (matchLayers(`${cafPrefix}${mapName}_${mode}`).length > 0)
                        break;
                }
            }
            
            let builtLayerString = `${cafPrefix}${mapName}_${mode}_${version}`;
            if (version === "Any")
            {
                let versions = matchLayers(`${cafPrefix}${mapName}_${mode}`);
                if (versions.length == 0)
                {
                    this.verbose(1, `error: could not find layer for ${builtLayerString} from vote rule \"${layerString}\"`);
                    continue;
                }
                versions = versions.map(l => l.layerid);
                version = randomElement(versions);
				version = version.substring(version.lastIndexOf("_") + 1, version.length);
                builtLayerString = `${cafPrefix}${mapName}_${mode}_${version}`;
            }

            if (!Layers.getLayerByCondition((layer) => layer.layerid === builtLayerString))
            {
                this.verbose(1, `error: could not find layer for ${builtLayerString} from vote rule \"${layerString}\"`);
                continue;
            }
            this.nominations.push(builtLayerString);
			this.tallies.push(0);
        }
    }

    //checks if there are enough players to start voting, if not binds itself to player connected
    //when there are enough players it clears old votes, sets up new nominations, and starts broadcast
    beginVoting(force = false)
    {
        const playerCount = this.server.players.length;
        const minPlayers = this.options.minPlayersForVote;

        if (this.votingEnabled) //voting has already started
            return;

        if (playerCount < minPlayers && !force)
        {
            if (this.onConnectBound == false)
            {
                this.server.on("PLAYER_CONNECTED", this.beginVoting)
                this.onConnectBound = true;
            }
            return;
        }
        if (this.onConnectBound)
        {
            this.server.removeEventListener("PLAYER_CONNECTED", this.beginVoting);
            this.onConnectBound = false;
        }

        // these need to be reset after reenabling voting
        this.trackedVotes = {};
        this.tallies = [];
        
        this.populateNominations();
        
        this.votingEnabled = true;
		this.broadcastNominations();
        this.broadcastIntervalTask = setInterval(this.broadcastNominations, toMils(this.options.voteBroadcastInterval));
    }
    
    endVoting()
    {
        this.votingEnabled = false;
        clearInterval(this.broadcastIntervalTask);
        this.broadcastIntervalTask = null;
    }

    //sends a message about nominations through a broadcast
	//NOTE: max squad broadcast message length appears to be 485 characters
    //Note: broadcast strings with multi lines are very strange
    async broadcastNominations()
    {
        await this.msgBroadcast("Type !vote <map number> in chat to cast your vote, Candidates:\n");
        let nominationStrings = [];
        for(let choice in this.nominations)
		{
			choice = Number(choice);
            nominationStrings.push(formatChoice(choice, this.nominations[choice], this.tallies[choice]));
		}
        await this.msgBroadcast(nominationStrings.join("\n"));
        //const winners = this.currentWinners;
        //await this.msgBroadcast(`Current winner${winners.length > 1 ? "s" : ""}: ${winners.join(", ")}`);
    }

    async directMsgNominations(steamID)
    {
        for(let choice in this.nominations)
		{
			choice = Number(choice);
            await this.msgDirect(steamID, formatChoice(choice, this.nominations[choice], this.tallies[choice]));
		}
        
        const winners = this.currentWinners;
        await this.msgDirect(steamID, `Current winner${winners.length > 1 ? "s" : ""}: ${winners.join(", ")}`);
    }

    //counts a vote from a player and adds it to tallies
    async registerVote(steamID, nominationIndex, playerName)
    {
        nominationIndex -= 1; // shift indices from display range
        if(nominationIndex < 0 || nominationIndex > this.nominations.length)
        {
            await this.msgDirect(steamID, `[Map Vote] ${playerName}: invalid map number, typ !vote results to see map numbers`);
            return;
        }
        
        const previousVote = this.trackedVotes[steamID];
        this.trackedVotes[steamID] = nominationIndex;
        
        this.tallies[nominationIndex] += 1;
        if(previousVote !== undefined)
            this.tallies[previousVote] -= 1;
		await this.msgDirect(steamID, `you voted for ${this.nominations[nominationIndex]}`);
    }
    
    //removes a players vote if they disconnect from the sever
    clearVote()
    {   
        const currentPlayers = this.server.players.map((p) => p.steamID);
        for (const steamID in this.trackedVotes)
		{
            if (!(currentPlayers.includes(steamID)))
            {
                const vote = this.trackedVotes[steamID];
                this.tallies[vote] -= 1;
                delete this.trackedVotes[steamID];
            }
		}
    }

    //calculates the current winner(s) of the vote and returns thier strings in an array
    get currentWinners()
    {
        const ties = [];
        
        let highestScore = -Infinity;
        for(let choice in this.tallies)
        {
            const score = this.tallies[choice];
            if(score < highestScore)
                continue;
            else if(score > highestScore)
            {
                highestScore = score;
                ties.length = 0;
                ties.push(choice);
            }
            else // equal
                ties.push(choice);
        }
        
        return ties.map(i => this.nominations[i]);
    }
}