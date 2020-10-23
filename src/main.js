
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let argv = require('yargs/yargs')(process.argv.slice(2))
	.usage('Usage: $0 [options]')
	.demandOption(['jira_url', 'username', 'password', 'project', 'cycle', 'testo_project_dir'])
	.describe('jira_url', 'target JIRA url (e.g. http://www.my_host.ru/jira')
	.describe('username', 'JIRA login')
	.describe('password', 'JIRA password')
	.describe('project', 'JIRA project name')
	.describe('cycle', 'TJ4M cycle to run by Testo')
	.describe('testo_project_dir', 'path to the dir with Testo tests')
	.argv;


let credentials = {
	username: argv.username,
	password: argv.password
}

let jira_rest_endpoint = argv.jira_url + "/rest/atm/1.0/"

async function main() {
	try {
		const cycles = await axios.get(jira_rest_endpoint + `testrun/search?query=projectKey = "${argv.project}"`, {auth: credentials});

		let tests_to_run = []

		for (let cycle of cycles.data) {
			if (cycle.key == argv.cycle) {
				for (let item of cycle.items) {
					tests_to_run.push(item.testCaseKey)
				}
				break;
			}
		}

		console.log(tests_to_run)


	} catch (error) {
		console.error("ERROR")
		console.error(error)
	}
}


main()

