import {GraphQLID, GraphQLNonNull, GraphQLString} from 'graphql'
import getRethink from 'server/database/rethinkDriver'
import AddGitHubRepoPayload from 'server/graphql/types/AddGitHubRepoPayload'
import tokenCanAccessRepo from 'server/integrations/tokenCanAccessRepo'
import {getUserId, isTeamMember} from 'server/utils/authorization'
import getPubSub from 'server/utils/getPubSub'
import makeGitHubWebhookParams from 'server/utils/makeGitHubWebhookParams'
import shortid from 'shortid'
import {GITHUB, GITHUB_ENDPOINT} from 'universal/utils/constants'
import makeGitHubPostOptions from 'universal/utils/makeGitHubPostOptions'
import maybeJoinRepos from 'server/safeMutations/maybeJoinRepos'
import fetch from 'node-fetch'
import standardError from 'server/utils/standardError'

const createRepoWebhook = async (accessToken, nameWithOwner, publicKey) => {
  const endpoint = `https://api.github.com/repos/${nameWithOwner}/hooks`
  const res = await fetch(endpoint, {
    headers: {Authorization: `Bearer ${accessToken}`}
  })
  const webhooks = await res.json()
  // no need for an extra call to repositoryOwner to find out if its an org because personal or no access is handled the same
  if (Array.isArray(webhooks) && webhooks.length === 0) {
    const createHookParams = makeGitHubWebhookParams(publicKey, [
      'issues',
      'issue_comment',
      'label',
      'member',
      'milestone',
      'pull_request',
      'pull_request_review',
      'repository'
    ])
    fetch(endpoint, makeGitHubPostOptions(accessToken, createHookParams))
  }
}

const getOrgQuery = `
query getOrg($login: String!) {
  organization(login: $login) {
    databaseId
  }
}`
const createOrgWebhook = async (accessToken, nameWithOwner) => {
  const [owner] = nameWithOwner.split('/')
  const endpoint = `https://api.github.com/orgs/${owner}/hooks`
  const res = await fetch(endpoint, {
    headers: {Authorization: `Bearer ${accessToken}`}
  })
  const webhooks = await res.json()
  // no need for an extra call to repositoryOwner to find out if its an org because personal or no access is handled the same
  if (Array.isArray(webhooks) && webhooks.length === 0) {
    const authedPostOptions = makeGitHubPostOptions(accessToken, {
      query: getOrgQuery,
      variables: {login: owner}
    })
    const ghProfile = await fetch(GITHUB_ENDPOINT, authedPostOptions)
    const profileRes = await ghProfile.json()
    if (profileRes.errors) {
      throw profileRes.errors
    }
    const {
      data: {
        organization: {databaseId}
      }
    } = profileRes
    const publickKey = String(databaseId)
    const createHookParams = makeGitHubWebhookParams(publickKey, ['organization'])
    fetch(endpoint, makeGitHubPostOptions(accessToken, createHookParams))
  }
}

export default {
  name: 'AddGitHubRepo',
  type: new GraphQLNonNull(AddGitHubRepoPayload),
  args: {
    teamId: {
      type: new GraphQLNonNull(GraphQLID)
    },
    nameWithOwner: {
      type: new GraphQLNonNull(GraphQLString)
    }
  },
  resolve: async (source, {teamId, nameWithOwner}, {authToken, socketId: mutatorId}) => {
    const r = getRethink()
    const now = new Date()
    const viewerId = getUserId(authToken)

    // AUTH
    if (!isTeamMember(authToken, teamId)) {
      return standardError(new Error('Team not found'), {userId: viewerId})
    }
    const userId = getUserId(authToken)

    // VALIDATION
    const allTeamProviders = await r
      .table('Provider')
      .getAll(teamId, {index: 'teamId'})
      .filter({service: GITHUB, isActive: true})

    const viewerProviderIdx = allTeamProviders.findIndex((provider) => provider.userId === userId)
    if (viewerProviderIdx === -1) {
      return standardError(new Error('GitHub Provider not found'), {userId: viewerId})
    }
    // first check if the viewer has permission. then, check the rest
    const {accessToken} = allTeamProviders[viewerProviderIdx]
    const viewerPermissions = await tokenCanAccessRepo(accessToken, nameWithOwner)
    const {data, errors} = viewerPermissions
    if (errors) return standardError(new Error('Unknown GitHub error'), {userId: viewerId})

    const {
      repository: {viewerCanAdminister, databaseId: ghRepoId}
    } = data
    if (!viewerCanAdminister) {
      return standardError(new Error('Not GitHub Administrator'), {userId: viewerId})
    }

    // RESOLUTION

    // add the webhooks on GitHub
    createRepoWebhook(accessToken, nameWithOwner, String(ghRepoId))
    createOrgWebhook(accessToken, nameWithOwner)

    // create or rehydrate the integration
    const newRepo = await r
      .table(GITHUB)
      .getAll(teamId, {index: 'teamId'})
      .filter({nameWithOwner})
      .nth(0)('id')
      .default(null)
      .do((integrationId) => {
        return r.branch(
          integrationId.eq(null),
          r.table(GITHUB).insert(
            {
              id: shortid.generate(),
              adminUserId: userId,
              createdAt: now,
              updatedAt: now,
              isActive: true,
              nameWithOwner,
              teamId,
              userIds: [userId]
            },
            {returnChanges: true}
          )('changes')(0)('new_val'),
          r
            .table(GITHUB)
            .get(integrationId)
            .update(
              {
                adminUserId: userId,
                isActive: true,
                userIds: [userId],
                updatedAt: now
              },
              {returnChanges: true}
            )('changes')(0)('new_val')
        )
      })

    // get a list of everyone else on the team that can join
    const teamMemberProviders = [
      ...allTeamProviders.slice(0, viewerProviderIdx),
      ...allTeamProviders.slice(viewerProviderIdx + 1)
    ]
    const usersAndIntegrations = await maybeJoinRepos([newRepo], teamMemberProviders)
    const userIds = Object.keys(usersAndIntegrations)
      .filter((userIdToAdd) => usersAndIntegrations[userIdToAdd].length > 0)
      .concat(userId)
    // doing this fetch here, before we publish to the pubsub, means we don't need to do it once per sub
    const repo = {
      ...newRepo,
      userIds,
      teamMembers: await r
        .table('TeamMember')
        .getAll(r.args(userIds), {index: 'userId'})
        .filter({teamId})
        .pluck('preferredName', 'picture', 'id')
    }

    const githubRepoAdded = {repo}
    getPubSub().publish(`githubRepoAdded.${teamId}`, {
      githubRepoAdded,
      mutatorId
    })

    // set up webhooks
    // const createHookParams = {
    //  name: 'web',
    //  config: {
    //    url: makeAppLink('webhooks/github'),
    //    content_type: 'json',
    //    //secret:
    //  },
    //  events: ["assigned", "unassigned", "labeled", "unlabeled", "opened", "edited", "milestoned", "demilestoned", "closed", "reopened"],
    //  active: true
    // };
    return githubRepoAdded
  }
}
