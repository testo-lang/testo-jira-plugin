
const axios = require('axios');

let argv = require('yargs/yargs')(process.argv.slice(2))
	.usage('Usage: $0 [options]')
	.demandOption(['jira_url', 'username', 'password', 'project'])
	.describe('jira_url', 'target JIRA url (e.g. http://www.my_host.ru/jira')
	.describe('username', 'JIRA login')
	.describe('password', 'JIRA password')
	.describe('project', 'JIRA project name')
	.argv;


let credentials = {
	username: argv.username,
	password: argv.password
}

let jira_rest_endpoint = argv.jira_url + "/rest/atm/1.0/"

async function main() {
	try {
		const cycles = await axios.get(jira_rest_endpoint + `testrun/search?query=projectKey = "${argv.project}"`, {auth: credentials});
		console.log(cycles.data)
	} catch (error) {
		console.error("ERROR")
		console.error(error)
	}
}


main()

