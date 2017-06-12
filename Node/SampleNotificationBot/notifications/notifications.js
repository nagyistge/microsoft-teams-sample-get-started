const builder = require("botbuilder");
const teams = require("botbuilder-teams");
const uuid = require('node-uuid');
const rest = require('restler');
const faker = require('faker');
const utils = require('../utils/utils.js');

///////////////////////////////////////////////////////
//	Local Variables
///////////////////////////////////////////////////////
var server; //Restify server
var chatConnector; 
var bot;
var access_token = {}; //Bearer token return by the auth call to the REST API
var rest_endpoint = null; //Endpoint to make REST requests, this is given to us when we start listening to a bot
var tenant_id = {}; //Our current tenant ID, his is given to us when we start listening to a bot


var host = process.env.BASE_URI // Our host endpoint

var addresses = {}; // Place to save bot connections


///////////////////////////////////////////////////////
//	Bot and listening
///////////////////////////////////////////////////////
function start_listening() {

	this.server.post('api/messages', this.chatConnector.listen()); // bind our one way bot to /api/messages


	// When a bot is added or removed we get an event here. Event type we are looking for is teamMember added
	this.bot.on('conversationUpdate', (msg) => {

		if (!rest_endpoint) rest_endpoint = msg.address.serviceUrl; // This is the base URL where we will send REST API request		

		//Get the event information using the Teams Extension SDK
		var event = teams.TeamsMessage.getConversationUpdateData(msg);

		//We're only parsing MembersAdded event for the sample:
		if (event.eventType != teams.TeamEventBase.TeamEventType.MembersAdded) 	return;

		var members = event.membersAdded;

		// Loop through all members that were just added to the team
		for (var i = 0; i < members.length; i++) {

			// See if the member added was our bot
			if (members[i].id.includes(process.env.MICROSOFT_APP_ID)) {


				// We are keeping track of unique addresses so we can send messages to multiple users and channels at the same time
				// Clean up so we don't blow up memory (I know, I know, but still)
				if (addresses.length > 100) {
					addresses = {};
					tenant_id = {};
					access_token = {};
				}

				var botmessage = new builder.Message()
					.address(msg.address)
					.text('Hello, I am a sample app. I am looking for the team members and will shortly send you a message');

				this.bot.send(botmessage, function (err) { });

				console.log('Sample app was added to the team');
				var guid = uuid.v4();
				tenant_id[guid] = msg.sourceEvent.tenant.id; // Extracting tenant ID as we will need it to create new conversations

				// Find all members currently in the team so we can send them a welcome message
				getMembers(msg, guid).then((ret) => {

					var msg = ret.msg;
					var members = ret.members;

					console.log('got members');

					// Prepare a message to the channel about the addition of this app. Write convenience URLs so 
					// we can easily send messages to the channel and individually to any user					
					var text = `##Just added the Sample App!! \n Send message to team: `
					text += `[Text](${host}/api/messages/send/team?id=${encodeURIComponent(guid)}), [Important](${host}/api/messages/send/team?id=${encodeURIComponent(guid)}&isImportant=true)`;
					text += ` | [Hero Card](${host}/api/messages/send/team?type=hero&id=${encodeURIComponent(guid)}), [Important](${host}/api/messages/send/team?type=hero&id=${encodeURIComponent(guid)}&isImportant=true)`;
					text += ` | [Thumbnail Card](${host}/api/messages/send/team?type=thumb&id=${encodeURIComponent(guid)}), [Important](${host}/api/messages/send/team?type=thumb&id=${encodeURIComponent(guid)}&isImportant=true)`;
					addresses[guid] = msg.address;

					function getEndpoint(type, guid, user, isImportant) {
						return `${host}/api/messages/send/user?type=${encodeURIComponent(type)}&id=${encodeURIComponent(guid)}&user=${encodeURIComponent(user)}&isImportant=${encodeURIComponent(isImportant)}`;
					}

					// Loop through and prepare convenience URLs for each user
					text += '\n\n';
					for (var i = 0; i < members.length; i++) {
						var user = members[i].id;
						var name = members[i].givenName || null;
						guid = uuid.v4();

						var nameString = (name) ? name : `user number ${i + 1}`;
						text += `Send message to ${nameString}: `
						text += `[Text](${getEndpoint('text', guid, user, false)}), `;
						text += `[Text alert](${getEndpoint('text', guid, user, true)}), `;
						text += `[Hero](${getEndpoint('hero', guid, user, false)}), ` 
						text += `[Hero Alert](${getEndpoint('hero', guid, user, true)}), `;
						text += `[Thumb](${getEndpoint('thumb', guid, user, false)}), `
						text += `[Thumb Alert](${getEndpoint('thumb', guid, user, true)})`;
						text += '\n\n';

						addresses[guid] = JSON.parse(JSON.stringify(msg.address)); // Make sure we mae a copy of an address to add to our addresses array
						tenant_id[guid] = msg.sourceEvent.tenant.id; // Extracting tenant ID as we will need it to create new conversations
					}

					// Go ahead and send the message
					try {
						var botmessage = new builder.Message()
							.address(msg.address)
							.textFormat(builder.TextFormat.markdown)
							.text(text);

						this.bot.send(botmessage, function (err) {

						});
					} catch (e) {
						console.log(`Cannot send message: ${e}`);
					}

				}, (err) => {

				});

			}
		}
	});

	// Endpoint to send one way messages to the team. If a message is important it will appear on a user's feed
	this.server.get('api/messages/send/team', (req, res) => {


		var address = addresses[decodeURIComponent(req.params.id)];
		var type = (typeof req.params.type === 'string') ? req.params.type : 'text';
		var isImportant = (typeof req.params.isImportant === 'string' && req.params.isImportant === 'true') ? true : false;

		if (!address) {
			res.send('Sorry cannot find your bot, please re-add the app');
			res.end();
			return;
		}

		console.log(`Sending Message to team: isImportant=${isImportant}`);

		try {

			var quote = faker.fake("{{lorem.sentence}}");
			var msg = new builder.Message().address(address);
			if (isImportant) msg.channelData = { notification: { alert: 'true' } };

			if (type === 'text') msg.text(quote);
			if (type === 'hero') msg.addAttachment(utils.createHeroCard(builder));
			if (type === 'thumb') msg.addAttachment(utils.createThumbnailCard(builder));

			if (type === 'text') res.send('Look on MS Teams, just sent: ' + quote);
			if (type === 'hero') res.send('Look on MS Teams, just sent a Hero card');
			if (type === 'thumb') res.send('Look on MS Teams, just sent a Thumbnail card');

			this.bot.send(msg, function (err) {
				// Return success/failure
				res.status(err ? 500 : 200);
				res.end();
			});
		} catch (e) { }
	});

	// Endpoint to send one way messages to individual users
	this.server.get('api/messages/send/user', (req, res) => {

		var guid = decodeURIComponent(req.params.id);
		var address = addresses[guid];
		var user = decodeURIComponent(req.params.user);
		var type = (typeof req.params.type === 'string') ? req.params.type : 'text';
		var isImportant = (typeof req.params.isImportant === 'string' && req.params.isImportant === 'true') ? true : false;

		if (!address) {
			res.send('Sorry cannot find your bot, please re-add the app');
			res.end();
			return;
		}

		if (!user) {
			res.send('Sorry cannot find your user, please re-add the app');
			res.end();
			return;
		}

		try {

			startConversation(user, guid, function (data) {
				var newConversationId = data.id;
				address.conversation.id = newConversationId;
				sendMessageToUser(address, type, res, isImportant);
			});
		} catch (e) { }
	});



}

///////////////////////////////////////////////////////
//	Helpers and other methods
///////////////////////////////////////////////////////

/*
	Convenience method for connecting to the bot framework REST API.
	Note that this endpoint requires data in the multipart/form format
	This method returns a promise with the bearer token to make subsequent REST API calls
*/
function connectToRestAPI(guid) {
	return new Promise((resolve, reject) => {

		var endpoint = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';

		console.log('Connecting to rest API: ' + access_token[guid]);
		if (typeof access_token[guid] !== 'undefined') resolve();

		rest.post(endpoint, {
			multipart: true,
			data: {
				'client_id': process.env.MICROSOFT_APP_ID,
				'client_secret': process.env.MICROSOFT_APP_PASSWORD,
				'scope': 'https://api.botframework.com/.default',
				'grant_type': 'client_credentials'
			}
		}).on('complete', (data) => {
			access_token[guid] = data.access_token;
			resolve(data.access_token);
		}).on('fail', (err) => {
			reject();
		});
	});
}

/*
	This is a convenience method to get all members in a channel using the REST API

	msg: a message of type IIs Message: https://docs.botframework.com/en-us/node/builder/chat-reference/classes/_botbuilder_d_.message.html

	returns a promise with a json object with:
		msg: the message that was passed in
		members: an array of members. Each member is a json object with an id property

	Notes:
		- the rest enpoint URL is contained in the msg as the serviceURL
		- conversation id is the full id returned in a message looks like 29:[someid]@skype....
*/
function getMembers(msg, guid) {

	var conversationId = msg.address.conversation.id;



	return new Promise((resolve, reject) => {
		connectToRestAPI(guid).then((token) => {
			access_token[guid] = token;

			console.log('Getting Members');
			console.log('Access token: ' + access_token[guid]);
			console.log('Tenant ID: ' + tenant_id[guid]);
			console.log('GUID: ' + guid);

			var endpoint = `${rest_endpoint}v3/conversations/${conversationId}/members`;
			rest.get(endpoint, {
				'headers': {
					'Authorization': 'Bearer ' + access_token[guid],
					'X-MsTeamsTenantId': tenant_id[guid]
				}
			}).on('complete', (data) => {
				console.log('Got members:');
				console.log(JSON.stringify(data, null, 1));
				resolve({
					msg: msg,
					members: data
				});
			}).on('fail', (err) => {
				reject(err);
			});
		}, (err) => {
			reject(err);
		});

	});
}

/*
	This is a convenience method to start a conversation using the rest API
	
	user: the user to which a message should be sent
	callback: a function to which we pass the conversation object when done. The conversation object is a javascript object with an id


	Notes:
		- the rest enpoint URL is contained in the msg as the serviceURL
		- Note that channelData is required, but only the tenant id part if a message is being sent to a user
		- If a message is being sent to a channel then the team id also needs to be part of channel data
*/
function startConversation(user, guid, callback) {

	var endpoint = `${rest_endpoint}v3/conversations`;
	var data = {
		"bot": {
			"id": "28:" + process.env.MICROSOFT_APP_ID,
			"name": "Sample Notify Bot"
		},
		"members": [{
			"id": user
		}],
		"channelData": {
			"tenant": {
				"id": tenant_id[guid]
			}
		}
	};

	rest.post(endpoint, {
		'headers': {
			'Authorization': 'Bearer ' + access_token[guid]
		},
		'data': JSON.stringify(data)
	}).on('complete', function (data) {
		console.log('Starting Conversation');
		callback(data);
	});
}

// This is a convenience method to send a message to a user
function sendMessageToUser(address, type, res, isImportant = false) {

	console.log(`Sending message to user: isImportant=${isImportant}`);
	var quote = faker.fake("{{lorem.sentence}}");
	var msg = new builder.Message().address(address);

	if (isImportant) msg.channelData = { notification: { alert: 'true' } };

	if (type === 'text') msg.text(quote);
	if (type === 'hero') msg.addAttachment(utils.createHeroCard(builder));
	if (type === 'thumb') msg.addAttachment(utils.createThumbnailCard(builder));

	if (type === 'text') res.send('Look on MS Teams, just sent: ' + quote);
	if (type === 'hero') res.send('Look on MS Teams, just sent a Hero card');
	if (type === 'thumb') res.send('Look on MS Teams, just sent a Thumbnail card');

	try {
		if (msg.attachments[0]) msg.attachments[0].content.tap = builder.CardAction.openUrl(null, 'http://teams.microsoft.com/l/', 'Open Teams');
	}
	catch (e) {
		res.send('Setting tap action failed');

	}

	this.bot.send(msg, function (err) {
		// Return success/failure
		res.status(err ? 500 : 200);
		res.end();
	});
}

///////////////////////////////////////////////////////
//	Exports
///////////////////////////////////////////////////////
module.exports.init = function (server, chatConnector, bot) {
	this.server = server;
	this.chatConnector = chatConnector;
	this.bot = bot;
	return this;
}

module.exports.start_listening = start_listening;