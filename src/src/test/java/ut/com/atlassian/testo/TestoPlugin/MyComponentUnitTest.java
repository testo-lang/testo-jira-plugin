package ut.com.atlassian.testo.TestoPlugin;

import org.junit.Test;
import com.atlassian.testo.TestoPlugin.api.MyPluginComponent;
import com.atlassian.testo.TestoPlugin.impl.MyPluginComponentImpl;

import static org.junit.Assert.assertEquals;

public class MyComponentUnitTest
{
    @Test
    public void testMyName()
    {
        MyPluginComponent component = new MyPluginComponentImpl(null);
        assertEquals("names do not match!", "myComponent",component.getName());
    }
}