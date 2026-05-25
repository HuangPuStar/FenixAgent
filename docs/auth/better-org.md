# Organization

The organization plugin allows you to manage your organization's members and teams.

Organizations simplifies user access and permissions management. Assign roles and permissions to streamline project management, team coordination, and partnerships.

Installation [#installation]

<Steps>
  <Step>
    Add the plugin to your auth config [#add-the-plugin-to-your-auth-config]

    ```ts title="auth.ts"
    import { betterAuth } from "better-auth"
    import { organization } from "better-auth/plugins" // [!code highlight]

    export const auth = betterAuth({
        plugins: [
            organization() // [!code highlight]
        ]
    })
    ```
  </Step>

  <Step>
    Migrate the database [#migrate-the-database]

    Run the migration or generate the schema to add the necessary fields and tables to the database.

    <Tabs items={["migrate", "generate"]}>
      <Tab value="migrate">
        <CodeBlockTabs defaultValue="npm" groupId="persist-install" persist>
          <CodeBlockTabsList>
            <CodeBlockTabsTrigger value="npm">
              npm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="pnpm">
              pnpm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="yarn">
              yarn
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="bun">
              bun
            </CodeBlockTabsTrigger>
          </CodeBlockTabsList>

          <CodeBlockTab value="npm">
            ```bash
            npx auth migrate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="pnpm">
            ```bash
            pnpm dlx auth migrate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="yarn">
            ```bash
            yarn dlx auth migrate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="bun">
            ```bash
            bun x auth migrate
            ```
          </CodeBlockTab>
        </CodeBlockTabs>
      </Tab>

      <Tab value="generate">
        <CodeBlockTabs defaultValue="npm" groupId="persist-install" persist>
          <CodeBlockTabsList>
            <CodeBlockTabsTrigger value="npm">
              npm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="pnpm">
              pnpm
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="yarn">
              yarn
            </CodeBlockTabsTrigger>

            <CodeBlockTabsTrigger value="bun">
              bun
            </CodeBlockTabsTrigger>
          </CodeBlockTabsList>

          <CodeBlockTab value="npm">
            ```bash
            npx auth generate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="pnpm">
            ```bash
            pnpm dlx auth generate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="yarn">
            ```bash
            yarn dlx auth generate
            ```
          </CodeBlockTab>

          <CodeBlockTab value="bun">
            ```bash
            bun x auth generate
            ```
          </CodeBlockTab>
        </CodeBlockTabs>
      </Tab>
    </Tabs>

    See the [Schema](#schema) section to add the fields manually.
  </Step>

  <Step>
    Add the client plugin [#add-the-client-plugin]

    ```ts title="auth-client.ts"
    import { createAuthClient } from "better-auth/client"
    import { organizationClient } from "better-auth/client/plugins" // [!code highlight]

    export const authClient = createAuthClient({
        plugins: [
            organizationClient() // [!code highlight]
        ]
    })
    ```
  </Step>
</Steps>

Usage [#usage]

Once you've installed the plugin, you can start using the organization plugin to manage your organization's members and teams. The client plugin will provide you with methods under the `organization` namespace, and the server `api` will provide you with the necessary endpoints to manage your organization and give you an easier way to call the functions on your own backend.

Organization [#organization]

Create an organization [#create-an-organization]

### Client Side

```ts
const { data, error } = await authClient.organization.create({
    name: My Organization,
    slug: my-org,
    logo: https://example.com/logo.png, // optional
    metadata, // optional
    userId: some_user_id, // optional
    keepCurrentActiveOrganization, // optional
});
```

### Server Side

```ts
const data = await auth.api.createOrganization({
    body: {
        name: My Organization,
        slug: my-org,
        logo: https://example.com/logo.png, // optional
        metadata, // optional
        userId: some_user_id, // optional
        keepCurrentActiveOrganization, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type createOrganization = {
    /**
    * The organization name.
    */
    name: string = "My Organization"
    /**
    * The organization slug.
    */
    slug: string = "my-org"
    /**
    * The organization logo.
    */
    logo?: string = "https://example.com/logo.png"
    /**
    * The metadata of the organization.
    */
    metadata?: Record<string, any>
    /**
    * The user ID of the organization creator.
    * @serverOnly - This is ignored if session headers are provided.
    */
    userId?: string = "some_user_id"
    /**
    * Whether to keep the current active organization active after creating a new one.
    */
    keepCurrentActiveOrganization?: boolean = false
  
}
```

<Callout type="warn">
  **Mutually Exclusive Parameters**

  The `userId` and session headers cannot be used together:

* **With session headers:** The organization is created for the authenticated session user. The `userId` field is **silently ignored**.
* **Without session headers (Server-side only):** The organization is created for the user specified by `userId`.

  **For Admins:** To create an organization on behalf of another user, you must make the API call server-side **without** passing session headers.
</Callout>

Restrict who can create an organization [#restrict-who-can-create-an-organization]

By default, any user can create an organization. To restrict this, set the `allowUserToCreateOrganization` option to a function that returns a boolean, or directly to `true` or `false`.

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

const auth = betterAuth({
  //...
  plugins: [
    organization({
      allowUserToCreateOrganization: async (user) => { // [!code highlight]
        const subscription = await getSubscription(user.id); // [!code highlight]
        return subscription.plan === "pro"; // [!code highlight]
      }, // [!code highlight]
    }),
  ],
});
```

Check if organization slug is taken [#check-if-organization-slug-is-taken]

To check if an organization slug is taken or not you can use the `checkSlug` function provided by the client. The function takes an object with the following properties:

### Client Side

```ts
const { data, error } = await authClient.organization.checkSlug({
    slug: my-org,
});
```

### Server Side

```ts
const data = await auth.api.checkOrganizationSlug({
    body: {
        slug: my-org,
    }
});
```

### Type Definition

```ts
type checkOrganizationSlug = {
      /**
       * The organization slug to check.  
       */
      slug: string = "my-org"
  
}
```

Organization Hooks [#organization-hooks]

You can customize organization operations using hooks that run before and after various organization-related activities. Better Auth provides two ways to configure hooks:

1. **Legacy organizationCreation hooks** (deprecated, use `organizationHooks` instead)
2. **Modern organizationHooks** (recommended) - provides comprehensive control over all organization-related activities

Organization Creation and Management Hooks [#organization-creation-and-management-hooks]

Control organization lifecycle operations:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [
    organization({
      organizationHooks: {
        // Organization creation hooks
        beforeCreateOrganization: async ({ organization, user }) => {
          // Run custom logic before organization is created
          // Optionally modify the organization data
          return {
            data: {
              ...organization,
              metadata: {
                customField: "value",
              },
            },
          };
        },

        afterCreateOrganization: async ({ organization, member, user }) => {
          // Run custom logic after organization is created
          // e.g., create default resources, send notifications
          await setupDefaultResources(organization.id);
        },

        // Organization update hooks
        beforeUpdateOrganization: async ({ organization, user, member }) => {
          // Validate updates, apply business rules
          return {
            data: {
              ...organization,
              name: organization.name?.toLowerCase(),
            },
          };
        },

        afterUpdateOrganization: async ({ organization, user, member }) => {
          // Sync changes to external systems
          await syncOrganizationToExternalSystems(organization);
        },
      },
    }),
  ],
});
```

<Callout type="info">
  The legacy `organizationCreation` hooks are still supported but deprecated.
  Use `organizationHooks.beforeCreateOrganization` and
  `organizationHooks.afterCreateOrganization` instead for new projects.
</Callout>

Member Hooks [#member-hooks]

Control member operations within organizations:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [
    organization({
      organizationHooks: {
        // Before a member is added to an organization
        beforeAddMember: async ({ member, user, organization }) => {
          // Custom validation or modification
          console.log(`Adding ${user.email} to ${organization.name}`);

          // Optionally modify member data
          return {
            data: {
              ...member,
              role: "custom-role", // Override the role
            },
          };
        },

        // After a member is added
        afterAddMember: async ({ member, user, organization }) => {
          // Send welcome email, create default resources, etc.
          await sendWelcomeEmail(user.email, organization.name);
        },

        // Before a member is removed
        beforeRemoveMember: async ({ member, user, organization }) => {
          // Cleanup user's resources, send notification, etc.
          await cleanupUserResources(user.id, organization.id);
        },

        // After a member is removed
        afterRemoveMember: async ({ member, user, organization }) => {
          await logMemberRemoval(user.id, organization.id);
        },

        // Before updating a member's role
        beforeUpdateMemberRole: async ({
          member,
          newRole,
          user,
          organization,
        }) => {
          // Validate role change permissions
          if (newRole === "owner" && !hasOwnerUpgradePermission(user)) {
            throw new Error("Cannot upgrade to owner role");
          }

          // Optionally modify the role
          return {
            data: {
              role: newRole,
            },
          };
        },

        // After updating a member's role
        afterUpdateMemberRole: async ({
          member,
          previousRole,
          user,
          organization,
        }) => {
          await logRoleChange(user.id, previousRole, member.role);
        },
      },
    }),
  ],
});
```

Invitation Hooks [#invitation-hooks]

Control invitation lifecycle:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [
    organization({
      organizationHooks: {
        // Before creating an invitation
        beforeCreateInvitation: async ({
          invitation,
          inviter,
          organization,
        }) => {
          // Custom validation or expiration logic
          const customExpiration = new Date(
            Date.now() + 1000 * 60 * 60 * 24 * 7
          ); // 7 days

          return {
            data: {
              ...invitation,
              expiresAt: customExpiration,
            },
          };
        },

        // After creating an invitation
        afterCreateInvitation: async ({
          invitation,
          inviter,
          organization,
        }) => {
          // Send custom invitation email, track metrics, etc.
          await sendCustomInvitationEmail(invitation, organization);
        },

        // Before accepting an invitation
        beforeAcceptInvitation: async ({ invitation, user, organization }) => {
          // Additional validation before acceptance
          await validateUserEligibility(user, organization);
        },

        // After accepting an invitation
        afterAcceptInvitation: async ({
          invitation,
          member,
          user,
          organization,
        }) => {
          // Setup user account, assign default resources
          await setupNewMemberResources(user, organization);
        },

        // Before/after rejecting invitations
        beforeRejectInvitation: async ({ invitation, user, organization }) => {
          // Log rejection reason, send notification to inviter
        },

        afterRejectInvitation: async ({ invitation, user, organization }) => {
          await notifyInviterOfRejection(invitation.inviterId, user.email);
        },

        // Before/after cancelling invitations
        beforeCancelInvitation: async ({
          invitation,
          cancelledBy,
          organization,
        }) => {
          // Verify cancellation permissions
        },

        afterCancelInvitation: async ({
          invitation,
          cancelledBy,
          organization,
        }) => {
          await logInvitationCancellation(invitation.id, cancelledBy.id);
        },
      },
    }),
  ],
});
```

Team Hooks [#team-hooks]

Control team operations (when teams are enabled):

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [
    organization({
      teams: { enabled: true },
      organizationHooks: {
        // Before creating a team
        beforeCreateTeam: async ({ team, user, organization }) => {
          // Validate team name, apply naming conventions
          return {
            data: {
              ...team,
              name: team.name.toLowerCase().replace(/\s+/g, "-"),
            },
          };
        },

        // After creating a team
        afterCreateTeam: async ({ team, user, organization }) => {
          // Create default team resources, channels, etc.
          await createDefaultTeamResources(team.id);
        },

        // Before updating a team
        beforeUpdateTeam: async ({ team, updates, user, organization }) => {
          // Validate updates, apply business rules
          return {
            data: {
              ...updates,
              name: updates.name?.toLowerCase(),
            },
          };
        },

        // After updating a team
        afterUpdateTeam: async ({ team, user, organization }) => {
          await syncTeamChangesToExternalSystems(team);
        },

        // Before deleting a team
        beforeDeleteTeam: async ({ team, user, organization }) => {
          // Backup team data, notify members
          await backupTeamData(team.id);
        },

        // After deleting a team
        afterDeleteTeam: async ({ team, user, organization }) => {
          await cleanupTeamResources(team.id);
        },

        // Team member operations
        beforeAddTeamMember: async ({
          teamMember,
          team,
          user,
          organization,
        }) => {
          // Validate team membership limits, permissions
          const memberCount = await getTeamMemberCount(team.id);
          if (memberCount >= 10) {
            throw new Error("Team is full");
          }
        },

        afterAddTeamMember: async ({
          teamMember,
          team,
          user,
          organization,
        }) => {
          await grantTeamAccess(user.id, team.id);
        },

        beforeRemoveTeamMember: async ({
          teamMember,
          team,
          user,
          organization,
        }) => {
          // Backup user's team-specific data
          await backupTeamMemberData(user.id, team.id);
        },

        afterRemoveTeamMember: async ({
          teamMember,
          team,
          user,
          organization,
        }) => {
          await revokeTeamAccess(user.id, team.id);
        },
      },
    }),
  ],
});
```

Hook Error Handling [#hook-error-handling]

All hooks support error handling. Throwing an error in a `before` hook will prevent the operation from proceeding:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { APIError } from "better-auth/api";

export const auth = betterAuth({
  plugins: [
    organization({
      organizationHooks: {
        beforeAddMember: async ({ member, user, organization }) => {
          // Check if user has pending violations
          const violations = await checkUserViolations(user.id);
          if (violations.length > 0) {
            throw new APIError("BAD_REQUEST", {
              message:
                "User has pending violations and cannot join organizations",
            });
          }
        },

        beforeCreateTeam: async ({ team, user, organization }) => {
          // Validate team name uniqueness
          const existingTeam = await findTeamByName(team.name, organization.id);
          if (existingTeam) {
            throw new APIError("BAD_REQUEST", {
              message: "Team name already exists in this organization",
            });
          }
        },
      },
    }),
  ],
});
```

List User's Organizations [#list-users-organizations]

To list the organizations that a user is a member of, you can use `useListOrganizations` hook. It implements a reactive way to get the organizations that the user is a member of.

<Tabs items={["React", "Vue", "Svelte"]} default="React">
  <Tab value="React">
    ```tsx title="client.tsx"
    import { authClient } from "@/lib/auth-client"

    function App(){
    const { data: organizations } = authClient.useListOrganizations()
    return (
      <div>
        {organizations.map((org) => (
          <p>{org.name}</p>
        ))}
      </div>)
    }
    ```
  </Tab>

  <Tab value="Svelte">
    ```svelte title="page.svelte"
    <script lang="ts">
      import { authClient } from "$lib/auth-client";
      const organizations = authClient.useListOrganizations();
    </script>

    <h1>Organizations</h1>

    {#if $organizations.isPending}

      <p>Loading...</p>
    {:else if !$organizations.data?.length}
      <p>No organizations found.</p>
    {:else}
      <ul>
        {#each $organizations.data as organization}
          <li>{organization.name}</li>
        {/each}
      </ul>
    {/if}
    ```
  </Tab>

  <Tab value="Vue">
    ```vue title="organization.vue"
    <script lang="ts">;
    export default {
        setup() {
            const organizations = authClient.useListOrganizations()
            return { organizations };
        }
    };
    </script>

    <template>
        <div>
            <h1>Organizations</h1>
            <div v-if="organizations.isPending">Loading...</div>
            <div v-else-if="organizations.data === null">No organizations found.</div>
            <ul v-else>
                <li v-for="organization in organizations.data" :key="organization.id">
                    {{ organization.name }}
                </li>
            </ul>
        </div>
    </template>
    ```
  </Tab>
</Tabs>

Or alternatively, you can call `organization.list` if you don't want to use a hook.

### Client Side

```ts
const { data, error } = await authClient.organization.list({});
```

### Server Side

```ts
const data = await auth.api.listOrganizations({

    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listOrganizations = {
  
}
```

Active Organization [#active-organization]

Active organization is the workspace the user is currently working on. By default when the user is signed in the active organization is set to `null`. You can set the active organization to the user session.

<Callout type="info">
  It's not always you want to persist the active organization in the session.
  You can manage the active organization in the client side only. For example,
  multiple tabs can have different active organizations.
</Callout>

Set Active Organization [#set-active-organization]

You can set the active organization by calling the `organization.setActive` function. It'll set the active organization for the user session.

<Callout>
  In some applications, you may want the ability to unset an active
  organization. In this case, you can call this endpoint with `organizationId`
  set to `null`.
</Callout>

### Client Side

```ts
const { data, error } = await authClient.organization.setActive({
    organizationId: org-id, // optional
    organizationSlug: org-slug, // optional
});
```

### Server Side

```ts
const data = await auth.api.setActiveOrganization({
    body: {
        organizationId: org-id, // optional
        organizationSlug: org-slug, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type setActiveOrganization = {
      /**
       * The organization ID to set as active. It can be null to unset the active organization.  
       */
      organizationId?: string | null = "org-id"
      /**
       * The organization slug to set as active. It can be null to unset the active organization if organizationId is not provided.  
       */
      organizationSlug?: string = "org-slug"
  
}
```

To automatically set an active organization when a session is created, you can use [database hooks](/docs/concepts/database#database-hooks). You'll need to implement logic to determine which organization to set as the initial active organization.

```ts title="auth.ts"
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // Implement your custom logic to set initial active organization
          const organization = await getInitialOrganization(session.userId);
          return {
            data: {
              ...session,
              activeOrganizationId: organization?.id,
            },
          };
        },
      },
    },
  },
});
```

Use Active Organization [#use-active-organization]

To retrieve the active organization for the user, you can call the `useActiveOrganization` hook. It returns the active organization for the user. Whenever the active organization changes, the hook will re-evaluate and return the new active organization.

<Tabs items={['React', 'Vue', 'Svelte']}>
  <Tab value="React">
    ```tsx title="client.tsx"
    import { authClient } from "@/lib/auth-client"

    function App(){
        const { data: activeOrganization } = authClient.useActiveOrganization()
        return (
            <div>
                {activeOrganization ? <p>{activeOrganization.name}</p> : null}
            </div>
        )
    }
    ```
  </Tab>

  <Tab value="Svelte">
    ```tsx title="client.tsx"
    <script lang="ts">
    import { authClient } from "$lib/auth-client";
    const activeOrganization = authClient.useActiveOrganization();
    </script>

    <h2>Active Organization</h2>

    {#if $activeOrganization.isPending}
    <p>Loading...</p>
    {:else if $activeOrganization.data === null}
    <p>No active organization found.</p>
    {:else}
    <p>{$activeOrganization.data.name}</p>
    {/if}
    ```
  </Tab>

  <Tab value="Vue">
    ```vue title="organization.vue"
    <script lang="ts">;
    export default {
        setup() {
            const activeOrganization = authClient.useActiveOrganization();
            return { activeOrganization };
        }
    };
    </script>

    <template>
        <div>
            <h2>Active organization</h2>
            <div v-if="activeOrganization.isPending">Loading...</div>
            <div v-else-if="activeOrganization.data === null">No active organization.</div>
            <div v-else>
                {{ activeOrganization.data.name }}
            </div>
        </div>
    </template>
    ```
  </Tab>
</Tabs>

Get Full Organization [#get-full-organization]

To get the full details of an organization, you can use the `getFullOrganization` function.
By default, if you don't pass any properties, it will use the active organization.

### Client Side

```ts
const { data, error } = await authClient.organization.getFullOrganization({
    organizationId: org-id, // optional
    organizationSlug: org-slug, // optional
    membersLimit, // optional
});
```

### Server Side

```ts
const data = await auth.api.getFullOrganization({
    query: {
        organizationId: org-id, // optional
        organizationSlug: org-slug, // optional
        membersLimit, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type getFullOrganization = {
      /**
       * The organization ID to get. By default, it will use the active organization.  
       */
      organizationId?: string = "org-id"
      /**
       * The organization slug to get.  
       */
      organizationSlug?: string = "org-slug"
      /**
       * The limit of members to get. By default, it uses the membershipLimit option which defaults to 100.
       */
      membersLimit?: number = 100
  
}
```

Update Organization [#update-organization]

To update organization info, you can use `organization.update`

### Client Side

```ts
const { data, error } = await authClient.organization.update({
    data,
    name: updated-name, // optional
    slug: updated-slug, // optional
    logo: new-logo.url, // optional
    metadata, // optional
});
```

### Server Side

```ts
const data = await auth.api.updateOrganization({
    body: {
        data,
        name: updated-name, // optional
        slug: updated-slug, // optional
        logo: new-logo.url, // optional
        metadata, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type updateOrganization = {
      /**
       * A partial list of data to update the organization. 
       */
      data: {
          /**
           * The name of the organization. 
           */
          name?: string = "updated-name"
          /**
           * The slug of the organization. 
           */
          slug?: string = "updated-slug"
          /**
           * The logo of the organization. 
           */
          logo?: string = "new-logo.url"
          /**
           * The metadata of the organization. 
           */
          metadata?: Record<string, any> | null = { customerId: "test" 
}
```

Delete Organization [#delete-organization]

To remove user owned organization, you can use `organization.delete`

### Client Side

```ts
const { data, error } = await authClient.organization.delete({
    organizationId: org-id,
});
```

### Server Side

```ts
const data = await auth.api.deleteOrganization({
    body: {
        organizationId: org-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type deleteOrganization = {
      /*
      * The organization ID to delete.
      */
      organizationId: string = "org-id"
  
}
```

If the user has the necessary permissions (by default: role is owner) in the specified organization, all members, invitations and organization information will be removed.

You can configure how organization deletion is handled through `organizationDeletion` option:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

const auth = betterAuth({
  plugins: [
    organization({
      disableOrganizationDeletion: true, //to disable it altogether
      organizationHooks: {
        beforeDeleteOrganization: async (data, request) => {
          // a callback to run before deleting org
        },
        afterDeleteOrganization: async (data, request) => {
          // a callback to run after deleting org
        },
      },
    }),
  ],
});
```

Invitations [#invitations]

To add a member to an organization, we first need to send an invitation to the user. The user will receive an email/sms with the invitation link. Once the user accepts the invitation, they will be added to the organization.

Setup Invitation Email [#setup-invitation-email]

For member invitation to work we first need to provide `sendInvitationEmail` to the `better-auth` instance. This function is responsible for sending the invitation email to the user.

You'll need to construct and send the invitation link to the user. The link should include the invitation ID, which will be used with the acceptInvitation function when the user clicks on it.

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { sendOrganizationInvitation } from "./email";

export const auth = betterAuth({
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        const inviteLink = `https://example.com/accept-invitation/${data.id}`;
        sendOrganizationInvitation({
          email: data.email,
          invitedByUsername: data.inviter.user.name,
          invitedByEmail: data.inviter.user.email,
          teamName: data.organization.name,
          inviteLink,
        });
      },
    }),
  ],
});
```

Send Invitation [#send-invitation]

To invite users to an organization, you can use the `invite` function provided by the client. The `invite` function takes an object with the following properties:

### Client Side

```ts
const { data, error } = await authClient.organization.inviteMember({
    email: example@gmail.com,
    role: member,
    organizationId: org-id, // optional
    resend, // optional
    teamId: team-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.createInvitation({
    body: {
        email: example@gmail.com,
        role: member,
        organizationId: org-id, // optional
        resend, // optional
        teamId: team-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type createInvitation = {
      /**
       * The email address of the user to invite.  
       */
      email: string = "example@gmail.com"
      /**
       * The role(s) to assign to the user. It can be `admin`, `member`, `owner`
       */
      role: string | string[] = "member"
      /**
       * The organization ID to invite the user to. Defaults to the active organization.  
       */
      organizationId?: string = "org-id"
      /**
       * Resend the invitation email, if the user is already invited.  
       */
      resend?: boolean = true
      /**
       * The team ID to invite the user to.  
       */
      teamId?: string = "team-id"
  
}
```

<Callout>
  * If the user is already a member of the organization, the invitation will be
    canceled.
  * If the user is already invited to the organization, unless `resend` is set
    to `true`, the invitation will not be sent again.
  * If `cancelPendingInvitationsOnReInvite` is set to `true`, the invitation will
    be canceled if the user is already invited to the organization and a new
    invitation is sent.
</Callout>

Accept Invitation [#accept-invitation]

When a user receives an invitation email, they can click on the invitation link to accept the invitation. The invitation link should include the invitation ID, which will be used to accept the invitation.

Make sure to call the `acceptInvitation` function after the user is logged in.

### Client Side

```ts
const { data, error } = await authClient.organization.acceptInvitation({
    invitationId: invitation-id,
});
```

### Server Side

```ts
const data = await auth.api.acceptInvitation({
    body: {
        invitationId: invitation-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type acceptInvitation = {
      /**
       * The ID of the invitation to accept.  
       */
      invitationId: string = "invitation-id"
  
}
```

Email Verification Requirement [#email-verification-requirement]

If the `requireEmailVerificationOnInvitation` option is enabled in your organization configuration, users must verify their email address before they can accept invitations. This adds an extra security layer to ensure that only verified users can join your organization.

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: true, // [!code highlight]
      async sendInvitationEmail(data) {
        // ... your email sending logic
      },
    }),
  ],
});
```

Cancel Invitation [#cancel-invitation]

If a user has sent out an invitation, you can use this method to cancel it.

If you're looking for how a user can reject an invitation, you can find that in the [reject invitation section](#reject-invitation).

### Client Side

```ts
const { data, error } = await authClient.organization.cancelInvitation({
    invitationId: invitation-id,
});
```

### Server Side

```ts
await auth.api.cancelInvitation({
    body: {
        invitationId: invitation-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type cancelInvitation = {
      /**
       * The ID of the invitation to cancel.  
       */
      invitationId: string = "invitation-id"
  
}
```

Reject Invitation [#reject-invitation]

If this user has received an invitation, but wants to decline it, this method will allow you to do so by rejecting it.

### Client Side

```ts
const { data, error } = await authClient.organization.rejectInvitation({
    invitationId: invitation-id,
});
```

### Server Side

```ts
await auth.api.rejectInvitation({
    body: {
        invitationId: invitation-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type rejectInvitation = {
      /**
       * The ID of the invitation to reject.  
       */
      invitationId: string = "invitation-id"
  
}
```

<Callout type="info">
  Like accepting invitations, rejecting invitations also requires email
  verification when the `requireEmailVerificationOnInvitation` option is
  enabled. Users with unverified emails will receive an error when attempting to
  reject invitations.
</Callout>

Get Invitation [#get-invitation]

To get an invitation you can use the `organization.getInvitation` function provided by the client. You need to provide the invitation id as a query parameter.

### Client Side

```ts
const { data, error } = await authClient.organization.getInvitation({
    id: invitation-id,
});
```

### Server Side

```ts
const data = await auth.api.getInvitation({
    query: {
        id: invitation-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type getInvitation = {
      /**
       * The ID of the invitation to get.  
       */
      id: string = "invitation-id"
  
}
```

List Invitations [#list-invitations]

To list all invitations for a given organization you can use the `listInvitations` function provided by the client.

### Client Side

```ts
const { data, error } = await authClient.organization.listInvitations({
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.listInvitations({
    query: {
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listInvitations = {
      /**
       * An optional ID of the organization to list invitations for. If not provided, will default to the user's active organization. 
       */
      organizationId?: string = "organization-id"
  
}
```

List user invitations [#list-user-invitations]

To list all invitations for a given user you can use the `listUserInvitations` function provided by the client.

```ts
import { authClient } from "@/lib/auth-client"

const invitations = await authClient.organization.listUserInvitations();
```

On the server, you can pass the user ID as a query parameter.

```ts title="list-user-invitations.ts"
const invitations = await auth.api.listUserInvitations({
  query: {
    email: "user@example.com",
  },
});
```

<Callout type="warn">
  The `email` query parameter is only available on the server to query for
  invitations for a specific user.
</Callout>

Members [#members]

List Members [#list-members]

To list all members of an organization you can use the `listMembers` function.

### Client Side

```ts
const { data, error } = await authClient.organization.listMembers({
    organizationId: organization-id, // optional
    limit, // optional
    offset, // optional
    sortBy: createdAt, // optional
    sortDirection: desc, // optional
    filterField: createdAt, // optional
    filterOperator: eq, // optional
    filterValue: value, // optional
});
```

### Server Side

```ts
const data = await auth.api.listMembers({
    query: {
        organizationId: organization-id, // optional
        limit, // optional
        offset, // optional
        sortBy: createdAt, // optional
        sortDirection: desc, // optional
        filterField: createdAt, // optional
        filterOperator: eq, // optional
        filterValue: value, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listMembers = {
      /**
       * An optional organization ID to list members for. If not provided, will default to the user's active organization.
       */
      organizationId?: string = "organization-id"
      /**
       * The limit of members to return.
       */
      limit?: number = 100
      /**
       * The offset to start from.
       */
      offset?: number = 0
      /**
       * The field to sort by.
       */
      sortBy?: string = "createdAt"
      /**
       * The direction to sort by.
       */
      sortDirection?: "asc" | "desc" = "desc"
      /**
       * The field to filter by.
       */
      filterField?: string = "createdAt"
      /**
       * The operator to filter by.
       */
      filterOperator?: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "not_in" | "contains" | "starts_with" | "ends_with" = "eq"
      /**
       * The value to filter by.
       */
      filterValue?: string | number | boolean | string[] | number[] = "value"
  
}
```

Remove Member [#remove-member]

To remove you can use `organization.removeMember`

### Client Side

```ts
const { data, error } = await authClient.organization.removeMember({
    memberIdOrEmail: user@example.com,
    organizationId: org-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.removeMember({
    body: {
        memberIdOrEmail: user@example.com,
        organizationId: org-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type removeMember = {
      /**
       * The ID or email of the member to remove. 
       */
      memberIdOrEmail: string = "user@example.com"
      /**
       * The ID of the organization to remove the member from. If not provided, the active organization will be used. 
       */
      organizationId?: string = "org-id"
  
}
```

Update Member Role [#update-member-role]

To update the role of a member in an organization, you can use the `organization.updateMemberRole`. If the user has the permission to update the role of the member, the role will be updated.

### Client Side

```ts
const { data, error } = await authClient.organization.updateMemberRole({
    role,
    memberId: member-id,
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
await auth.api.updateMemberRole({
    body: {
        role,
        memberId: member-id,
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type updateMemberRole = {
      /**
       * The new role to be applied. This can be a string or array of strings representing the roles. 
       */
      role: string | string[] = ["admin", "sale"]
      /**
       * The member id to apply the role update to. 
       */
      memberId: string = "member-id"
      /**
       * An optional organization ID which the member is a part of to apply the role update. If not provided, you must provide session headers to get the active organization. 
       */
      organizationId?: string = "organization-id"
  
}
```

Get Active Member [#get-active-member]

To get the current member of the active organization you can use the `organization.getActiveMember` function. This function will return the user's member details in their active organization.

### Client Side

```ts
const { data, error } = await authClient.organization.getActiveMember({});
```

### Server Side

```ts
const member = await auth.api.getActiveMember({

    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type getActiveMember = {
  
}
```

Get Active Member Role [#get-active-member-role]

To get the current role member of the active organization you can use the `organization.getActiveMemberRole` function. This function will return the user's member role in their active organization.

### Client Side

```ts
const { data, error } = await authClient.organization.getActiveMemberRole({});
```

### Server Side

```ts
const { role } = await auth.api.getActiveMemberRole({

    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type getActiveMemberRole = {
  
}
```

Add Member [#add-member]

If you want to add a member directly to an organization without sending an invitation, you can use the `addMember` function which can only be invoked on the server.

### Client Side

```ts
const { data, error } = await authClient.organization.addMember({
    userId: user-id, // optional
    role,
    organizationId: org-id, // optional
    teamId: team-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.addMember({
    body: {
        userId: user-id, // optional
        role,
        organizationId: org-id, // optional
        teamId: team-id, // optional
    }
});
```

### Type Definition

```ts
type addMember = {
      /**
       * The user ID which represents the user to be added as a member. If `null` is provided, then it's expected to provide session headers. 
       */
      userId?: string | null = "user-id"
      /**
       * The role(s) to assign to the new member. 
       */
      role: string | string[] = ["admin", "sale"]
      /**
       * An optional organization ID to pass. If not provided, will default to the user's active organization. 
       */
      organizationId?: string = "org-id"
      /**
       * An optional team ID to add the member to. 
       */
      teamId?: string = "team-id"
  
}
```

Leave Organization [#leave-organization]

To leave organization you can use `organization.leave` function. This function will remove the current user from the organization.

### Client Side

```ts
const { data, error } = await authClient.organization.leave({
    organizationId: organization-id,
});
```

### Server Side

```ts
await auth.api.leaveOrganization({
    body: {
        organizationId: organization-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type leaveOrganization = {
      /**
       * The organization ID for the member to leave. 
       */
      organizationId: string = "organization-id"
  
}
```

Access Control [#access-control]

The organization plugin provides a very flexible access control system. You can control the access of the user based on the role they have in the organization. You can define your own set of permissions based on the role of the user.

Roles [#roles]

By default, there are three roles in the organization:

`owner`: The user who created the organization by default. The owner has full control over the organization and can perform any action.

`admin`: Users with the admin role have full control over the organization except for deleting the organization or changing the owner.

`member`: Users with the member role have limited control over the organization. They can only read organization data and have no permissions to create, update, or delete resources.

<Callout>
  A user can have multiple roles. Multiple roles are stored as string separated
  by comma (",").
</Callout>

Permissions [#permissions]

By default, there are three resources, and these have two to three actions.

**organization**:

`update` `delete`

**member**:

`create` `update` `delete`

**invitation**:

`create` `cancel`

The owner has full control over all the resources and actions. The admin has full control over all the resources except for deleting the organization or changing the owner. The member has no control over any of those actions other than reading the data.

Custom Permissions [#custom-permissions]

The plugin provides an easy way to define your own set of permissions for each role.

<Steps>
  <Step>
    Create Access Control [#create-access-control]

    You first need to create access controller by calling `createAccessControl` function and passing the statement object. The statement object should have the resource name as the key and the array of actions as the value.

    ```ts title="permissions.ts"
    import { createAccessControl } from "better-auth/plugins/access";

    /**
     * make sure to use `as const` so typescript can infer the type correctly
     */
    const statement = { // [!code highlight]
        project: ["create", "share", "update", "delete"], // [!code highlight]
    } as const; // [!code highlight]

    const ac = createAccessControl(statement); // [!code highlight]
    ```

    <Callout type="warning">
      To keep bundle sizes small, make sure to import from `better-auth/plugins/access` instead of `better-auth/plugins`.
    </Callout>
  </Step>

  <Step>
    Create Roles [#create-roles]

    Once you have created the access controller you can create roles with the permissions you have defined.

    ```ts title="permissions.ts"
    import { createAccessControl } from "better-auth/plugins/access";

    const statement = {
        project: ["create", "share", "update", "delete"],
    } as const;

    const ac = createAccessControl(statement);

    const member = ac.newRole({ // [!code highlight]
        project: ["create"], // [!code highlight]
    }); // [!code highlight]

    const admin = ac.newRole({ // [!code highlight]
        project: ["create", "update"], // [!code highlight]
    }); // [!code highlight]

    const owner = ac.newRole({ // [!code highlight]
        project: ["create", "update", "delete"], // [!code highlight]
    }); // [!code highlight]

    const myCustomRole = ac.newRole({ // [!code highlight]
        project: ["create", "update", "delete"], // [!code highlight]
        organization: ["update"], // [!code highlight]
    }); // [!code highlight]
    ```

    When you create custom roles for existing roles, the predefined permissions for those roles will be overridden. To add the existing permissions to the custom role, you need to import `defaultStatements` and merge it with your new statement, plus merge the roles' permissions set with the default roles.

    ```ts title="permissions.ts"
    import { createAccessControl } from "better-auth/plugins/access";
    import { defaultStatements, adminAc } from 'better-auth/plugins/organization/access'

    const statement = {
        ...defaultStatements, // [!code highlight]
        project: ["create", "share", "update", "delete"],
    } as const;

    const ac = createAccessControl(statement);

    const admin = ac.newRole({
        project: ["create", "update"],
        ...adminAc.statements, // [!code highlight]
    });
    ```
  </Step>

  <Step>
    Pass Roles to the Plugin [#pass-roles-to-the-plugin]

    Once you have created the roles you can pass them to the organization plugin both on the client and the server.

    ```ts title="auth.ts"
    import { betterAuth } from "better-auth"
    import { organization } from "better-auth/plugins"
    import { ac, owner, admin, member } from "@/auth/permissions"

    export const auth = betterAuth({
        plugins: [
            organization({
                ac,
                roles: {
                    owner,
                    admin,
                    member,
                    myCustomRole
                }
            }),
        ],
    });
    ```

    You also need to pass the access controller and the roles to the client plugin.

    ```ts title="auth-client"
    import { createAuthClient } from "better-auth/client"
    import { organizationClient } from "better-auth/client/plugins"
    import { ac, owner, admin, member, myCustomRole } from "@/auth/permissions"

    export const authClient = createAuthClient({
        plugins: [
            organizationClient({
                ac,
                roles: {
                    owner,
                    admin,
                    member,
                    myCustomRole
                }
            })
      ]
    })
    ```
  </Step>
</Steps>

Access Control Usage [#access-control-usage]

**Has Permission**:

You can use the `hasPermission` action provided by the `api` to check the permission of the user.

```ts title="has-permission.ts"
import { auth } from "@/lib/auth"

await auth.api.hasPermission({
  headers: await headers(),
  body: {
    permissions: {
      project: ["create"], // This must match the structure in your access control
    },
  },
});

// You can also check multiple resource permissions at the same time
await auth.api.hasPermission({
  headers: await headers(),
  body: {
    permissions: {
      project: ["create"], // This must match the structure in your access control
      sale: ["create"],
    },
  },
});
```

If you want to check the permission of the user on the client from the server you can use the `hasPermission` function provided by the client.

```ts title="auth-client.ts"
const canCreateProject = await authClient.organization.hasPermission({
  permissions: {
    project: ["create"],
  },
});

// You can also check multiple resource permissions at the same time
const canCreateProjectAndCreateSale =
  await authClient.organization.hasPermission({
    permissions: {
      project: ["create"],
      sale: ["create"],
    },
  });
```

**Check Role Permission**:

Once you have defined the roles and permissions to avoid checking the permission from the server you can use the `checkRolePermission` function provided by the client.

```ts title="auth-client.ts"
import { authClient } from "@/lib/auth-client"

const canCreateProject = authClient.organization.checkRolePermission({
  permissions: {
    organization: ["delete"],
  },
  role: "admin",
});

// You can also check multiple resource permissions at the same time
const canCreateProjectAndCreateSale =
  authClient.organization.checkRolePermission({
    permissions: {
      organization: ["delete"],
      member: ["delete"],
    },
    role: "admin",
  });
```

<Callout type="warn">
  This will not include any dynamic roles as everything is ran synchronously on the client side.
  Please use the [hasPermission](#access-control-usage) APIs to include checks for any dynamic roles & permissions.
</Callout>

***

Dynamic Access Control [#dynamic-access-control]

Dynamic access control allows you to create roles at runtime for organizations. This is achieved by storing the
created roles and permissions associated with an organization in a database table.

Enabling Dynamic Access Control [#enabling-dynamic-access-control]

To enable dynamic access control, pass the `dynamicAccessControl` configuration option with `enabled` set to `true` to both server and client plugins.

Ensure you have pre-defined an `ac` instance on the server auth plugin.
This is important as this is how we can infer the permissions that are available for use.

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { ac } from "@/auth/permissions";

export const auth = betterAuth({
    plugins: [
        organization({ // [!code highlight]
            ac, // Must be defined in order for dynamic access control to work // [!code highlight]
            dynamicAccessControl: { // [!code highlight]
              enabled: true, // [!code highlight]
            }, // [!code highlight]
        }) // [!code highlight]
    ]
})
```

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    plugins: [
        organizationClient({ // [!code highlight]
            dynamicAccessControl: { // [!code highlight]
              enabled: true, // [!code highlight]
            }, // [!code highlight]
        }) // [!code highlight]
    ]
})
```

<Callout>
  This will require you to run migrations to add the new `organizationRole` table to the database.
</Callout>

<Callout type="warn">
  The `authClient.organization.checkRolePermission` function will not include any dynamic roles as everything is ran synchronously on the client side.
  Please use the [hasPermission](#access-control-usage) APIs to include checks for any dynamic roles.
</Callout>

Creating a role [#creating-a-role]

To create a new role for an organization at runtime, you can use the `createRole` function.

Only users with roles which contain the `ac` resource with the `create` permission can create a new role.
By default, only the `admin` and `owner` roles have this permission. You also cannot add permissions that your
current role in that organization can't already access.

### Client Side

```ts
const { data, error } = await authClient.organization.createRole({
    role: my-unique-role,
    permission, // optional
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
await auth.api.createOrgRole({
    body: {
        role: my-unique-role,
        permission, // optional
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type createOrgRole = {
      /**
       * A unique name of the role to create.
       */
      role: string = "my-unique-role"
      /**
       * The permissions to assign to the role.
       */
      permission?: Record<string, string[]> = permission,
      /**
       * The organization ID which the role will be created in. Defaults to the active organization.
       */
      organizationId?: string = "organization-id"
  
}
```

Now you can freely call [`updateMemberRole`](#update-member-role) to update the role of a member with your newly created role!

Deleting a role [#deleting-a-role]

To delete a role, you can use the `deleteRole` function, then provide either a `roleName` or `roleId` parameter along
with the `organizationId` parameter.

### Client Side

```ts
const { data, error } = await authClient.organization.deleteRole({
    roleName: my-role, // optional
    roleId: role-id, // optional
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
await auth.api.deleteOrgRole({
    body: {
        roleName: my-role, // optional
        roleId: role-id, // optional
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type deleteOrgRole = {
      /**
       * The name of the role to delete. Alternatively, you can pass a `roleId` parameter instead.
       */
      roleName?: string = "my-role"
      /**
       * The id of the role to delete. Alternatively, you can pass a `roleName` parameter instead.
       */
      roleId?: string = "role-id"
      /**
       * The organization ID which the role will be deleted in. Defaults to the active organization.
       */
      organizationId?: string = "organization-id"
  
}
```

Listing roles [#listing-roles]

To list roles, you can use the `listOrgRoles` function.
This requires the `ac` resource with the `read` permission for the member to be able to list roles.

### Client Side

```ts
const { data, error } = await authClient.organization.listRoles({
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
const roles = await auth.api.listOrgRoles({
    query: {
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listOrgRoles = {
      /**
       * The organization ID which the roles are under to list. Defaults to the user's active organization. 
       */
      organizationId?: string = "organization-id"
  
}
```

Getting a specific role [#getting-a-specific-role]

To get a specific role, you can use the `getOrgRole` function and pass either a `roleName` or `roleId` parameter.
This requires the `ac` resource with the `read` permission for the member to be able to get a role.

### Client Side

```ts
const { data, error } = await authClient.organization.getRole({
    roleName: my-role, // optional
    roleId: role-id, // optional
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
const role = await auth.api.getOrgRole({
    query: {
        roleName: my-role, // optional
        roleId: role-id, // optional
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type getOrgRole = {
      /**
       * The name of the role to get. Alternatively, you can pass a `roleId` parameter instead.
       */
      roleName?: string = "my-role"
      /**
       * The id of the role to get. Alternatively, you can pass a `roleName` parameter instead.
       */
      roleId?: string = "role-id"
      /**
       * The organization ID from which the role will be retrieved. Defaults to the active organization.
       */
      organizationId?: string = "organization-id"
  
}
```

Updating a role [#updating-a-role]

To update a role, you can use the `updateOrgRole` function and pass either a `roleName` or `roleId` parameter.

### Client Side

```ts
const { data, error } = await authClient.organization.updateRole({
    roleName: my-role, // optional
    roleId: role-id, // optional
    organizationId: organization-id, // optional
    data,
    permission, // optional
});
```

### Server Side

```ts
const updatedRole = await auth.api.updateOrgRole({
    body: {
        roleName: my-role, // optional
        roleId: role-id, // optional
        organizationId: organization-id, // optional
        data,
        permission, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type updateOrgRole = {
      /**
       * The name of the role to update. Alternatively, you can pass a `roleId` parameter instead.
       */
      roleName?: string = "my-role"
      /**
       * The id of the role to update. Alternatively, you can pass a `roleName` parameter instead.
       */
      roleId?: string = "role-id"
      /**
       * The organization ID which the role will be updated in. Defaults to the active organization.
       */
      organizationId?: string = "organization-id"
      /**
       * The data which will be updated
      */
      data: {
        /**
         * Optionally update the permissions of the role.
         */
        permission?: Record<string, string[]> = { project: ["create", "update", "delete"] 
}
```

Configuration Options [#configuration-options]

Below is a list of options that can be passed to the `dynamicAccessControl` object.

enabled [#enabled]

This option is used to enable or disable dynamic access control. By default, it is disabled.

```ts
organization({
  dynamicAccessControl: {
    enabled: true // [!code highlight]
  }
})
```

maximumRolesPerOrganization [#maximumrolesperorganization]

This option is used to limit the number of roles that can be created for an organization.

By default, the maximum number of roles that can be created for an organization is infinite.

```ts
organization({
  dynamicAccessControl: {
    maximumRolesPerOrganization: 10 // [!code highlight]
  }
})
```

You can also pass a function that returns a number.

```ts
organization({
  dynamicAccessControl: {
    maximumRolesPerOrganization: async (organizationId) => { // [!code highlight]
      const organization = await getOrganization(organizationId); // [!code highlight]
      return organization.plan === "pro" ? 100 : 10; // [!code highlight]
    } // [!code highlight]
  }
})
```

Additional Fields [#additional-fields]

To add additional fields to the `organizationRole` table, you can pass the `additionalFields` configuration option to the `organization` plugin.

```ts
organization({
  schema: {
    organizationRole: {
      additionalFields: {
        // Role colors!
        color: {
          type: "string",
          defaultValue: "#ffffff",
        },
        //... other fields
      },
    },
  },
})
```

Then, if you don't already use `inferOrgAdditionalFields` to infer the additional fields, you can use it to infer the additional fields.

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client"
import { organizationClient, inferOrgAdditionalFields } from "better-auth/client/plugins"
import type { auth } from "@/lib/auth" // import the auth object type only

export const authClient = createAuthClient({
    plugins: [
        organizationClient({
            schema: inferOrgAdditionalFields<typeof auth>()
        })
    ]
})
```

Otherwise, you can pass the schema values directly, the same way you do on the org plugin in the server.

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client"
import { organizationClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
    plugins: [
        organizationClient({
            schema: {
                organizationRole: {
                    additionalFields: {
                        color: {
                            type: "string",
                            defaultValue: "#ffffff",
                        }
                    }
                }
            }
        })
    ]
})
```

***

Teams [#teams]

Teams allow you to group members within an organization. The teams feature provides additional organization structure and can be used to manage permissions at a more granular level.

Enabling Teams [#enabling-teams]

To enable teams, pass the `teams` configuration option to both server and client plugins:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [
    organization({
      teams: {
        enabled: true,
        maximumTeams: 10, // Optional: limit teams per organization
        allowRemovingAllTeams: false, // Optional: prevent removing the last team
      },
    }),
  ],
});
```

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [
    organizationClient({
      teams: {
        enabled: true,
      },
    }),
  ],
});
```

Managing Teams [#managing-teams]

Create Team [#create-team]

Create a new team within an organization:

### Client Side

```ts
const { data, error } = await authClient.organization.createTeam({
    name: my-team,
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.createTeam({
    body: {
        name: my-team,
        organizationId: organization-id, // optional
    }
});
```

### Type Definition

```ts
type createTeam = {
      /**
       * The name of the team. 
       */
      name: string = "my-team"
      /**
       * The organization ID which the team will be created in. Defaults to the active organization. 
       */
      organizationId?: string = "organization-id"
  
}
```

List Teams [#list-teams]

Get all teams in an organization:

### Client Side

```ts
const { data, error } = await authClient.organization.listTeams({
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.listOrganizationTeams({
    query: {
        organizationId: organization-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listOrganizationTeams = {
      /**
      * The organization ID which the teams are under to list. Defaults to the user's active organization. 
      */
      organizationId?: string = "organization-id"
  
}
```

Update Team [#update-team]

Update a team's details:

### Client Side

```ts
const { data, error } = await authClient.organization.updateTeam({
    teamId: team-id,
    data,
    name: My new team name, // optional
    organizationId: My new organization ID for this team, // optional
    createdAt, // optional
    updatedAt, // optional
});
```

### Server Side

```ts
const data = await auth.api.updateTeam({
    body: {
        teamId: team-id,
        data,
        name: My new team name, // optional
        organizationId: My new organization ID for this team, // optional
        createdAt, // optional
        updatedAt, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type updateTeam = {
      /**
       * The ID of the team to be updated. 
       */
      teamId: string = "team-id"
      /**
       * A partial object containing options for you to update.
       */
      data: {
          /**
           * The name of the team to be updated.
           */
          name?: string = "My new team name"
          /**
           * The organization ID which the team falls under.
           */
          organizationId?: string = "My new organization ID for this team"
          /**
           * The timestamp of when the team was created.
           */
          createdAt?: Date = new Date()
          /**
           * The timestamp of when the team was last updated.
           */
          updatedAt?: Date = new Date()
      
}
```

Remove Team [#remove-team]

Delete a team from an organization:

### Client Side

```ts
const { data, error } = await authClient.organization.removeTeam({
    teamId: team-id,
    organizationId: organization-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.removeTeam({
    body: {
        teamId: team-id,
        organizationId: organization-id, // optional
    }
});
```

### Type Definition

```ts
type removeTeam = {
      /**
       * The team ID of the team to remove. 
       */
      teamId: string = "team-id"
      /**
       * The organization ID which the team falls under. If not provided, it will default to the user's active organization. 
       */
      organizationId?: string = "organization-id"
  
}
```

Set Active Team [#set-active-team]

Sets the given team as the current active team for the current active organization. If `teamId` is `null` the current active team is unset.

### Client Side

```ts
const { data, error } = await authClient.organization.setActiveTeam({
    teamId: team-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.setActiveTeam({
    body: {
        teamId: team-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type setActiveTeam = {
      /**
       * The team ID of the team to set as the current active team.
       * The team must belong to the current active organization.
       */
      teamId?: string | null = "team-id"
  
}
```

List User Teams [#list-user-teams]

List all teams that the current user is a part of.

### Client Side

```ts
const { data, error } = await authClient.organization.listUserTeams({});
```

### Server Side

```ts
const data = await auth.api.listUserTeams({

    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listUserTeams = {
  
}
```

List Team Members [#list-team-members]

List the members of the given team.

### Client Side

```ts
const { data, error } = await authClient.organization.listTeamMembers({
    teamId: team-id, // optional
});
```

### Server Side

```ts
const data = await auth.api.listTeamMembers({
    query: {
        teamId: team-id, // optional
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type listTeamMembers = {
      /**
       * The team whose members we should return. If this is not provided the members of the current active team get returned.
       */
      teamId?: string = "team-id"
  
}
```

Add Team Member [#add-team-member]

Add a member to a team.

### Client Side

```ts
const { data, error } = await authClient.organization.addTeamMember({
    teamId: team-id,
    userId: user-id,
});
```

### Server Side

```ts
const data = await auth.api.addTeamMember({
    body: {
        teamId: team-id,
        userId: user-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type addTeamMember = {
      /**
       * The team the user should be a member of.
       */
      teamId: string = "team-id"
      /**
       * The user ID which represents the user to be added as a member.
       */
      userId: string = "user-id"
  
}
```

Remove Team Member [#remove-team-member]

Remove a member from a team.

### Client Side

```ts
const { data, error } = await authClient.organization.removeTeamMember({
    teamId: team-id,
    userId: user-id,
});
```

### Server Side

```ts
const data = await auth.api.removeTeamMember({
    body: {
        teamId: team-id,
        userId: user-id,
    },
    // This endpoint requires session cookies.
    headers: await headers()
});
```

### Type Definition

```ts
type removeTeamMember = {
      /**
       * The team the user should be removed from.
       */
      teamId: string = "team-id"
      /**
       * The user which should be removed from the team.
       */
      userId: string = "user-id"
  
}
```

Team Permissions [#team-permissions]

Teams follow the organization's permission system. To manage teams, users need the following permissions:

* `team:create` - Create new teams
* `team:update` - Update team details
* `team:delete` - Remove teams

By default:

* Organization owners and admins can manage teams
* Regular members cannot create, update, or delete teams

Team Configuration Options [#team-configuration-options]

The teams feature supports several configuration options:

* `maximumTeams`: Limit the number of teams per organization

  ```ts
  teams: {
    enabled: true,
    maximumTeams: 10 // Fixed number
    // OR
    maximumTeams: async ({ organizationId, session }, ctx) => {
      // Dynamic limit based on organization plan
      const plan = await getPlan(organizationId)
      return plan === 'pro' ? 20 : 5
    },
    maximumMembersPerTeam: 10 // Fixed number
    // OR
    maximumMembersPerTeam: async ({ teamId, session, organizationId }, ctx) => {
      // Dynamic limit based on team plan
      const plan = await getPlan(organizationId, teamId)
      return plan === 'pro' ? 50 : 10
    },
  }
  ```

* `allowRemovingAllTeams`: Control whether the last team can be removed

  ```ts
  teams: {
    enabled: true,
    allowRemovingAllTeams: false // Prevent removing the last team
  }
  ```

Team Members [#team-members]

When inviting members to an organization, you can specify a team:

```ts
await authClient.organization.inviteMember({
  email: "user@example.com",
  role: "member",
  teamId: "team-id",
});
```

The invited member will be added to the specified team upon accepting the invitation.

Database Schema [#database-schema]

When teams are enabled, new `team` and `teamMember` tables are added to the database.

Table Name: `team`

export const teamsFeatureTeamTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each team",
  isPrimaryKey: true,
 },
 {
  name: "name",
  type: "string",
  description: "The name of the team",
 },
 {
  name: "organizationId",
  type: "string",
  description: "The ID of the organization",
  isForeignKey: true,
  references: { model: "organization", field: "id" },
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the team was created",
 },
 {
  name: "updatedAt",
  type: "Date",
  isOptional: true,
  description: "Timestamp of when the team was created",
 },
];

<DatabaseTable name="team" fields={teamsFeatureTeamTableFields} />

Table Name: `teamMember`

export const teamsFeatureTeamMemberTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each team member",
  isPrimaryKey: true,
 },
 {
  name: "teamId",
  type: "string",
  description: "Unique identifier for each team",
  isForeignKey: true,
  references: { model: "team", field: "id" },
 },
 {
  name: "userId",
  type: "string",
  description: "The ID of the user",
  isForeignKey: true,
  references: { model: "user", field: "id" },
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the team member was created",
  isOptional: true,
 },
];

<DatabaseTable name="teamMember" fields={teamsFeatureTeamMemberTableFields} />

Schema [#schema]

The organization plugin adds the following tables to the database:

Organization [#organization-1]

Table Name: `organization`

export const organizationTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each organization",
  isPrimaryKey: true,
 },
 {
  name: "name",
  type: "string",
  description: "The name of the organization",
 },
 {
  name: "slug",
  type: "string",
  description: "The slug of the organization",
  isUnique: true,
 },
 {
  name: "logo",
  type: "string",
  description: "The logo of the organization",
  isOptional: true,
 },
 {
  name: "metadata",
  type: "string",
  description: "Additional metadata for the organization",
  isOptional: true,
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the organization was created",
 },
];

<DatabaseTable name="organization" fields={organizationTableFields} />

Member [#member]

Table Name: `member`

export const memberTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each member",
  isPrimaryKey: true,
 },
 {
  name: "userId",
  type: "string",
  description: "The ID of the user",
  isForeignKey: true,
  references: { model: "user", field: "id" },
 },
 {
  name: "organizationId",
  type: "string",
  description: "The ID of the organization",
  isForeignKey: true,
  references: { model: "organization", field: "id" },
 },
 {
  name: "role",
  type: "string",
  description: "The role of the user in the organization",
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the member was added to the organization",
 },
];

<DatabaseTable name="member" fields={memberTableFields} />

Invitation [#invitation]

Table Name: `invitation`

export const invitationTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each invitation",
  isPrimaryKey: true,
 },
 {
  name: "email",
  type: "string",
  description: "The email address of the user",
 },
 {
  name: "inviterId",
  type: "string",
  description: "The ID of the inviter",
  isForeignKey: true,
  references: { model: "user", field: "id" },
 },
 {
  name: "organizationId",
  type: "string",
  description: "The ID of the organization",
  isForeignKey: true,
  references: { model: "organization", field: "id" },
 },
 {
  name: "role",
  type: "string",
  description: "The role of the user in the organization",
  isOptional: true,
 },
 {
  name: "status",
  type: "string",
  description: "The status of the invitation",
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the invitation was created",
 },
 {
  name: "expiresAt",
  type: "Date",
  description: "Timestamp of when the invitation expires",
 },
];

<DatabaseTable name="invitation" fields={invitationTableFields} />

If teams are enabled, you need to add the following fields to the invitation table:

export const invitationTeamIdFields = [
 {
  name: "teamId",
  type: "string",
  description: "The ID of the team",
  isOptional: true,
 },
];

<DatabaseTable name="invitation" fields={invitationTeamIdFields} />

Session [#session]

Table Name: `session`

You need to add two more fields to the session table to store the active organization ID and the active team ID.

export const sessionActiveOrganizationFields = [
 {
  name: "activeOrganizationId",
  type: "string",
  description: "The ID of the active organization",
  isOptional: true,
 },
 {
  name: "activeTeamId",
  type: "string",
  description: "The ID of the active team",
  isOptional: true,
 },
];

<DatabaseTable name="session" fields={sessionActiveOrganizationFields} />

Organization Role (optional) [#organization-role-optional]

Table Name: `organizationRole`

export const organizationRoleTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each organization role",
 },
 {
  name: "organizationId",
  type: "string",
  description: "The ID of the organization",
  isForeignKey: true,
  references: { model: "organization", field: "id" },
 },
 {
  name: "role",
  type: "string",
  description: "The name of the role",
 },
 {
  name: "permission",
  type: "string",
  description: "The permission of the role",
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the organization role was created",
 },
 {
  name: "updatedAt",
  type: "Date",
  description: "Timestamp of when the organization role was updated",
  isOptional: true,
 },
];

<DatabaseTable name="organizationRole" fields={organizationRoleTableFields} />

Teams (optional) [#teams-optional]

Table Name: `team`

export const optionalTeamTableFields = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each team",
  isPrimaryKey: true,
 },
 {
  name: "name",
  type: "string",
  description: "The name of the team",
 },
 {
  name: "organizationId",
  type: "string",
  description: "The ID of the organization",
  isForeignKey: true,
  references: { model: "organization", field: "id" },
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the team was created",
 },
 {
  name: "updatedAt",
  type: "Date",
  isOptional: true,
  description: "Timestamp of when the team was created",
 },
];

<DatabaseTable name="team" fields={optionalTeamTableFields} />

Table Name: `teamMember`

export const teamsFeatureTeamTableFields0 = [
 {
  name: "id",
  type: "string",
  description: "Unique identifier for each team member",
  isPrimaryKey: true,
 },
 {
  name: "teamId",
  type: "string",
  description: "Unique identifier for each team",
  isForeignKey: true,
  references: { model: "team", field: "id" },
 },
 {
  name: "userId",
  type: "string",
  description: "The ID of the user",
  isForeignKey: true,
  references: { model: "user", field: "id" },
 },
 {
  name: "createdAt",
  type: "Date",
  description: "Timestamp of when the team member was created",
  isOptional: true,
 },
];

<DatabaseTable name="teamMember" fields={teamsFeatureTeamTableFields0} />

Table Name: `invitation`

export const teamsFeatureTeamTableFields1 = [
 {
  name: "teamId",
  type: "string",
  description: "The ID of the team",
  isOptional: true,
 },
];

<DatabaseTable name="invitation" fields={teamsFeatureTeamTableFields1} />

Customizing the Schema [#customizing-the-schema]

To change the schema table name or fields, you can pass `schema` option to the organization plugin.

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

const auth = betterAuth({
  plugins: [
    organization({
      schema: {
        organization: {
          modelName: "organizations", //map the organization table to organizations
          fields: {
            name: "title", //map the name field to title
          },
          additionalFields: {
            // Add a new field to the organization table
            myCustomField: {
              type: "string",
              input: true,
              required: false,
            },
          },
        },
      },
    }),
  ],
});
```

Additional Fields [#additional-fields-1]

Starting with [Better Auth v1.3](https://github.com/better-auth/better-auth/releases/tag/v1.3.0), you can easily add custom fields to the `organization`, `invitation`, `member`, and `team` tables.

When you add extra fields to a model, the relevant API endpoints will automatically accept and return these new properties. For instance, if you add a custom field to the `organization` table, the `createOrganization` endpoint will include this field in its request and response payloads as needed.

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

const auth = betterAuth({
  plugins: [
    organization({
      schema: {
        organization: {
          additionalFields: {
            myCustomField: {
              // [!code highlight]
              type: "string", // [!code highlight]
              input: true, // [!code highlight]
              required: false, // [!code highlight]
            }, // [!code highlight]
          },
        },
      },
    }),
  ],
});
```

For inferring the additional fields, you can use the `inferOrgAdditionalFields` function. This function will infer the additional fields from the auth object type.

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client";
import {
  inferOrgAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins";
import type { auth } from "@/lib/auth" // import the auth object type only

const client = createAuthClient({
  plugins: [
    organizationClient({
      schema: inferOrgAdditionalFields<typeof auth>(),
    }),
  ],
});
```

if you can't import the auth object type, you can use the `inferOrgAdditionalFields` function without the generic. This function will infer the additional fields from the schema object.

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client";
import {
  inferOrgAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins";

const client = createAuthClient({
  plugins: [
    organizationClient({
      schema: inferOrgAdditionalFields({
        organization: {
          // [!code highlight]
          additionalFields: {
            newField: {
              // [!code highlight]
              type: "string", // [!code highlight]
            }, // [!code highlight]
          },
        },
      }),
    }),
  ],
});
```

Example usage [#example-usage]

```ts
await client.organization.create({
  name: "Test",
  slug: "test",
  newField: "123", //this should be allowed
  //@ts-expect-error - this field is not available
  unavailableField: "123", //this should be not allowed
});
```

Options [#options]

**allowUserToCreateOrganization**: `boolean` | `((user: User) => Promise<boolean> | boolean)` - A function that determines whether a user can create an organization. By default, it's `true`. You can set it to `false` to restrict users from creating organizations.

**organizationLimit**: `number` | `((user: User) => Promise<boolean> | boolean)` - The maximum number of organizations allowed for a user. By default, it's `unlimited`. You can set it to any number you want, or a function that returns a boolean. **If you provide a function, it should return `true` if the user has reached their organization limit (blocking further creation), or `false` if they have not reached their limit (allowing further creation).**

**creatorRole**: `admin | owner` - The role of the user who creates the organization. By default, it's `owner`. You can set it to `admin`.

**membershipLimit**: `number` | `((user: User, organization: Organization) => Promise<number> | number)` - The maximum number of members allowed in an organization. By default, it's `100`. You can set it to any number you want or a function that returns the limit number.

**sendInvitationEmail**: `async (data) => Promise<void>` - A function that sends an invitation email to the user.

**invitationExpiresIn** : `number` - How long the invitation link is valid for in seconds. By default, it's 48 hours (2 days).

**cancelPendingInvitationsOnReInvite**: `boolean` - Whether to cancel pending invitations if the user is already invited to the organization. By default, it's `false`.

**invitationLimit**: `number` | `((user: User) => Promise<boolean> | boolean)` - The maximum number of invitations allowed for a user. By default, it's `100`. You can set it to any number you want or a function that returns a boolean.

**requireEmailVerificationOnInvitation**: `boolean` - Whether to require email verification before accepting or rejecting invitations. By default, it's `false`. When enabled, users must have verified their email address before they can accept or reject organization invitations.
